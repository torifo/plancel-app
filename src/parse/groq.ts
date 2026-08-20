/**
 * GroqParser — primary TEXT parser (Task 6.1, ADR-5, ADR-13).
 *
 * The model is NOT pinned to a family, because Groq retires models without
 * notice. `llama-3.3-70b-versatile` (the ADR-5 pick) answered
 * 404 model_not_found, and by 2026-08-20 the account listed no Llama chat
 * model at all: every pasted text had been falling through to Gemini alone,
 * and nothing anywhere said so. Chosen instead: the largest general model
 * Groq lists that honours `response_format: json_object`. qwen3.6-27b was
 * rejected — it answers json_validate_failed on this prompt.
 *
 * Free-tier limits measured 2026-08-20 on this account: 1,000 req/min and
 * 8,000 tokens/min. The prompt alone is ~1.5K tokens, so the per-minute
 * token cap allows roughly four parses a minute — far above a family's few
 * reservations a day, but it is the limit a burst hits first — and it says
 * so with a 429 rather than a wrong answer.
 *
 * Text-only (`supports` rejects images — the image route is pinned to
 * Gemini per SDD §5). Never throws: any failure (missing key, HTTP error,
 * network error, empty response) becomes `output: null` so chain.ts falls
 * through to the next parser.
 */
import type { ParseInput, Parser, ParseResult } from "./types.ts";
import type { Clock } from "../core/clock/mod.ts";
import {
  extractReservationJson,
  parserError,
  postRetryingOn5xx,
  PROVIDER_RETRY_DELAY_MS,
  reservationPromptForClock,
  resolveApiKey,
} from "./llm.ts";

// The chain-slot id, not a claim about the model: `parsers.config.json`, the
// recorded replay corpus in `fixtures/parse/` and every stored ParseJob key
// this parser's attempts by this string. Renaming it would rewrite history
// that says what the Llama model actually answered, so the id stays put and
// GROQ_DEFAULT_MODEL alone says what is being asked today.
export const GROQ_PARSER_NAME = "groq-llama";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
const GROQ_DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY_ENV = "GROQ_API_KEY";

export interface GroqParserOptions {
  /** Defaults to the GROQ_API_KEY environment variable, read at parse time. */
  apiKey?: string;
  /** Anchors the prompt's year-inference rule to today's JST date. */
  clock?: Clock;
  model?: string;
  endpoint?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Pause before the single 5xx retry; 0 disables the wait (tests). */
  retryDelayMs?: number;
}

export function GroqParser(options: GroqParserOptions = {}): Parser {
  const model = options.model ?? GROQ_DEFAULT_MODEL;
  const endpoint = options.endpoint ?? GROQ_DEFAULT_ENDPOINT;
  const doFetch = options.fetch ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? PROVIDER_RETRY_DELAY_MS;

  return {
    name: GROQ_PARSER_NAME,
    supports: (input: ParseInput) => input.type === "text",
    async parse(input: ParseInput): Promise<ParseResult> {
      const apiKey = resolveApiKey(options.apiKey, GROQ_API_KEY_ENV);
      if (apiKey === undefined) {
        return parserError(`${GROQ_API_KEY_ENV} is not set`);
      }

      let body: string;
      try {
        const { res, body: answered } = await postRetryingOn5xx(doFetch, endpoint, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: reservationPromptForClock(options.clock) },
              { role: "user", content: input.content },
            ],
          }),
        }, retryDelayMs);
        body = answered;
        if (!res.ok) {
          return parserError(`groq http ${res.status}: ${body}`);
        }
      } catch (err) {
        return parserError(
          `groq request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let content: string | undefined;
      try {
        const data = JSON.parse(body) as {
          choices?: { message?: { content?: string } }[];
        };
        content = data.choices?.[0]?.message?.content ?? undefined;
      } catch {
        return parserError(`groq returned non-JSON body: ${body}`);
      }
      if (content === undefined || content === "") {
        return parserError(`groq response had no message content: ${body}`);
      }

      // raw_response is the model's own text (SDD §3.5: LLM の生応答を必ず全保存) —
      // the replay harness re-derives output from it via extractReservationJson.
      return { raw_response: content, output: extractReservationJson(content) };
    },
  };
}
