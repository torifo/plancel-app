/**
 * Enforces FR-008: domain code must not call `Date.now()`, `new Date()`, or
 * `Temporal.Now.*` directly — it must receive time via the `Clock`
 * abstraction (src/core/clock/). Deno's lint plugin API does not currently
 * support authoring a custom rule for this, so this script scans src/ as a
 * substitute and is wired into `deno task check`.
 *
 * Allowlisted files (system-time entry points / non-domain concerns):
 *   - src/core/clock/system.ts   — SystemClock is the sanctioned place to
 *                                  read Temporal.Now.instant().
 *   - src/lib/log.ts             — observability, not domain logic; the
 *                                  logger's default timestamp source only
 *                                  (callers may inject `now` for tests).
 *   - src/lib/ulid.ts            — ULID generation needs a system time
 *                                  default but exposes an injectable `now`
 *                                  option so domain/test code stays
 *                                  deterministic; this file is the sole
 *                                  place Date.now() is used as that default.
 *   - any *_test.ts file or path under a `tests/` directory — tests
 *                                  legitimately construct fixed/system dates.
 *
 * Usage: deno run --allow-read scripts/no_direct_date_check.ts [rootDir]
 * Exits 1 and prints `path:line: <offending line>` for each violation found.
 */

const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Date.now(", re: /\bDate\.now\s*\(/ },
  { name: "new Date(", re: /\bnew\s+Date\s*\(/ },
  { name: "Temporal.Now", re: /\bTemporal\.Now\b/ },
];

const ALLOWLIST = [
  "src/core/clock/system.ts",
  "src/lib/log.ts",
  "src/lib/ulid.ts",
];

function isAllowlisted(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  if (ALLOWLIST.includes(normalized)) return true;
  if (normalized.endsWith("_test.ts")) return true;
  if (normalized.includes("/tests/") || normalized.startsWith("tests/")) return true;
  return false;
}

interface Violation {
  path: string;
  line: number;
  text: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.isFile && path.endsWith(".ts")) {
      yield path;
    }
  }
}

export async function checkNoDirectDate(rootDir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const rootPrefix = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;

  for await (const path of walk(rootDir)) {
    const relPath = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
    // relPath here is relative to rootDir (e.g. "src"); reconstruct a
    // project-relative path for allowlist matching.
    const projectRelPath = `${rootDir.replace(/^\.\/?/, "")}/${relPath}`.replace(/^\/+/, "");
    if (isAllowlisted(projectRelPath) || isAllowlisted(relPath)) continue;

    const content = await Deno.readTextFile(path);
    const lines = content.split("\n");
    lines.forEach((lineText, idx) => {
      for (const { re } of FORBIDDEN_PATTERNS) {
        if (re.test(lineText)) {
          violations.push({ path: projectRelPath, line: idx + 1, text: lineText.trim() });
          break;
        }
      }
    });
  }

  return violations;
}

if (import.meta.main) {
  const rootDir = Deno.args[0] ?? "src";
  const violations = await checkNoDirectDate(rootDir);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.path}:${v.line}: ${v.text}`);
    }
    console.error(
      `\n${violations.length} direct Date/Temporal.Now call(s) found outside the Clock abstraction. ` +
        `Use src/core/clock/ (Clock/SystemClock/VirtualClock) instead.`,
    );
    Deno.exit(1);
  }
  console.log(
    "no_direct_date_check: OK (no direct Date.now()/new Date()/Temporal.Now outside allowlist)",
  );
}
