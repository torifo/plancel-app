/**
 * `deno task parse:live` — run the REAL parser chain (Groq/Gemini, Task 6.1)
 * against ad-hoc input, and optionally record the resulting ParseJob as a
 * replay fixture (SDD §10.4). This is the recording half of the Task 6.1
 * done-when ("実データ数件でリプレイ回帰が通る"): record a few real inputs
 * here, then flip parsers.config.json to the real chain (see real.ts) and
 * `deno task replay` becomes a real-data regression gate.
 *
 * Usage:
 *   deno task parse:live "8/1 19時 〇〇レストラン 2名 コース8000円"
 *   deno task parse:live --image path/to/screenshot.png
 *   deno task parse:live --record my-booking "..."   # writes fixtures/parse/my-booking.json
 *
 * Requires GROQ_API_KEY / GEMINI_API_KEY in the environment (a parser whose
 * key is missing reports an error attempt and the chain falls through).
 */
import { encodeBase64 } from "jsr:@std/encoding@^1.0.5/base64";
import { REAL_CHAIN_CONFIG, realParsers, recordFixture, runParseChain } from "../parse/mod.ts";
import type { ParseInput } from "../parse/mod.ts";
import { SystemClock } from "../core/clock/mod.ts";
import { ulid } from "../lib/ulid.ts";

const FIXTURES_DIR = new URL("../../fixtures/parse/", import.meta.url);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function usage(): never {
  console.error(
    "usage: deno task parse:live [--record <name>] (<text> | --image <path>)",
  );
  Deno.exit(2);
}

async function buildInput(args: string[]): Promise<{ input: ParseInput; rest: string[] }> {
  const imageIdx = args.indexOf("--image");
  const correlation_id = `live-${ulid()}`;
  if (imageIdx !== -1) {
    const path = args[imageIdx + 1];
    if (!path) usage();
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "image/jpeg";
    const bytes = await Deno.readFile(path);
    const content = `data:${mime};base64,${encodeBase64(bytes)}`;
    return {
      input: { type: "image", content, correlation_id },
      rest: args.filter((_, i) => i !== imageIdx && i !== imageIdx + 1),
    };
  }
  const text = args.find((a) => !a.startsWith("--"));
  if (!text) usage();
  return {
    input: { type: "text", content: text, correlation_id },
    rest: args.filter((a) => a !== text),
  };
}

if (import.meta.main) {
  const args = [...Deno.args];
  let recordName: string | null = null;
  const recordIdx = args.indexOf("--record");
  if (recordIdx !== -1) {
    recordName = args[recordIdx + 1] ?? null;
    if (!recordName) usage();
    args.splice(recordIdx, 2);
  }

  const { input } = await buildInput(args);
  const clock = new SystemClock();
  const ids = { ulid, nowIso: () => clock.now().toString({ smallestUnit: "millisecond" }) };

  const job = await runParseChain(input, REAL_CHAIN_CONFIG, realParsers(), clock, ids);

  console.log(`status: ${job.status}`);
  for (const attempt of job.attempts) {
    console.log(`\n--- attempt: ${attempt.parser} ---`);
    console.log(`raw_response: ${attempt.raw_response}`);
    console.log(`output: ${JSON.stringify(attempt.output, null, 2)}`);
    if (attempt.validation_errors.length > 0) {
      console.log(`validation: ${attempt.validation_errors.join(" / ")}`);
    }
  }
  if (job.conflicts.length > 0) {
    console.log(`\nconflicts: ${JSON.stringify(job.conflicts, null, 2)}`);
  }

  if (recordName !== null) {
    const fixture = { name: recordName, ...recordFixture(job) };
    const path = new URL(`${recordName}.json`, FIXTURES_DIR);
    await Deno.writeTextFile(path, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`\nrecorded fixture: fixtures/parse/${recordName}.json`);
  }

  Deno.exit(job.status === "failed" ? 1 : 0);
}
