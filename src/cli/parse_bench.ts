/**
 * parse:bench — asks one model every fixture in the corpus and scores it
 * against `truth` (see src/parse/bench.ts).
 *
 * This is what a provider retiring a model costs when it happens again: one
 * command, not an afternoon of reading JSON by eye (ADR-13).
 *
 *   deno task parse:bench                        # the current default model
 *   deno task parse:bench openai/gpt-oss-20b     # a candidate
 *   deno task parse:bench --parser gemini-flash  # the other provider
 *
 * Requests are spaced because the free tier's per-minute token budget is the
 * first thing a run like this hits: the prompt alone is ~1.5K tokens against
 * 8,000 a minute, so four in a row is already the limit.
 */
import {
  GEMINI_DEFAULT_MODEL,
  GeminiParser,
  GROQ_DEFAULT_MODEL,
  GroqParser,
} from "../parse/mod.ts";
import { compareToTruth, type FixtureTruth } from "../parse/bench.ts";
import type { Parser } from "../parse/mod.ts";
import { SystemClock } from "../core/clock/mod.ts";

const DIR = new URL("../../fixtures/parse/", import.meta.url);
/** Long enough that a run of ten does not spend the per-minute token budget. */
const SPACING_MS = 20_000;

interface Fixture {
  name?: string;
  raw_input: string;
  input_type: string;
  truth?: FixtureTruth;
}

function parserFor(which: string, model: string | undefined, clock: SystemClock): Parser {
  const opts = { clock, ...(model !== undefined ? { model } : {}) };
  return which === "gemini-flash" ? GeminiParser(opts) : GroqParser(opts);
}

if (import.meta.main) {
  const args = [...Deno.args];
  const pIndex = args.indexOf("--parser");
  const which = pIndex >= 0 ? args.splice(pIndex, 2)[1] ?? "groq-llama" : "groq-llama";
  const model = args[0];
  const clock = new SystemClock();
  const parser = parserFor(which, model, clock);
  const shown = model ?? (which === "gemini-flash" ? GEMINI_DEFAULT_MODEL : GROQ_DEFAULT_MODEL);

  const fixtures: Fixture[] = [];
  for await (const entry of Deno.readDir(DIR)) {
    if (!entry.name.endsWith(".json")) continue;
    const fx = JSON.parse(await Deno.readTextFile(new URL(entry.name, DIR))) as Fixture;
    // Only text, and only what has a hand-checked answer to score against.
    if (fx.input_type !== "text" || fx.truth === undefined) continue;
    fixtures.push({ ...fx, name: fx.name ?? entry.name.replace(/\.json$/, "") });
  }
  fixtures.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  console.log(`bench: ${which} / ${shown} — ${fixtures.length} fixtures\n`);
  let clean = 0;
  const failures: string[] = [];
  for (const [i, fx] of fixtures.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
    const result = await parser.parse({
      type: "text",
      content: fx.raw_input,
      correlation_id: `bench-${fx.name}`,
    });
    const mismatches = compareToTruth(result.output, fx.truth!);
    if (mismatches.length === 0) {
      clean += 1;
      console.log(`  OK   ${fx.name}`);
      continue;
    }
    failures.push(fx.name ?? "?");
    console.log(`  DIFF ${fx.name}`);
    for (const m of mismatches) console.log(`         ${m.field}: got ${m.got}  want ${m.want}`);
    if (fx.truth?.why) console.log(`         └ ${fx.truth.why}`);
  }
  console.log(`\n${clean}/${fixtures.length} match the text.`);
  if (failures.length > 0) console.log(`differs on: ${failures.join(", ")}`);
  // Non-zero so this can gate a model swap from a script.
  if (failures.length > 0) Deno.exit(1);
}
