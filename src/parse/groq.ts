/**
 * GroqParser — primary TEXT parser (Task 6.1, ADR-5: Groq Llama 3.3 70B).
 *
 * Free-tier quota recheck (ADR-5 note), as of 2026-07:
 * llama-3.3-70b-versatile on the free plan is ~30 req/min, 1,000 req/day,
 * 100K tokens/day — the tokens/day cap is the binding constraint, still far
 * above this product's expected parse volume (a few reservations/day).
 *
 * Text-only (`supports` rejects images — the image route is pinned to
 * Gemini per SDD §5). Never throws: any failure (missing key, HTTP error,
 * network error, empty response) becomes `output: null` so chain.ts falls
 * through to the next parser.
 */
import type { ParseInput, Parser, ParseResult } from "./types.ts";
import {
  extractReservationJson,
  parserError,
  RESERVATION_PARSE_PROMPT,
  resolveApiKey,
} from "./llm.ts";

export const GROQ_PARSER_NAME = "groq-llama";
export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const GROQ_DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY_ENV = "GROQ_API_KEY";

export interface GroqParserOptions {
  /** Defaults to the GROQ_API_KEY environment variable, read at parse time. */
  apiKey?: string;
  model?: string;
  endpoint?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function GroqParser(options: GroqParserOptions = {}): Parser {
  const model = options.model ?? GROQ_DEFAULT_MODEL;
  const endpoint = options.endpoint ?? GROQ_DEFAULT_ENDPOINT;
  const doFetch = options.fetch ?? fetch;

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
        const res = await doFetch(endpoint, {
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
              { role: "system", content: RESERVATION_PARSE_PROMPT },
              { role: "user", content: input.content },
            ],
          }),
        });
        body = await res.text();
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
