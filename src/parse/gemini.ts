/**
 * GeminiParser — secondary TEXT parser and the ONLY image parser
 * (Task 6.1, ADR-5: vision 経路は Gemini 固定, SDD §5).
 *
 * Free-tier quota recheck (ADR-5 note), as of 2026-07: gemini-2.5-flash on
 * the free tier is ~10 req/min / 250 req/day (Google cut free quotas
 * sharply in Dec 2025 — recheck again before deploy). Still comfortably
 * above this product's expected parse volume. Privacy: free-tier inputs may
 * be used for training, which is why chain.ts masks PII before any parser
 * sees the input (SDD §5 プライバシー).
 *
 * Image inputs arrive as `ParseInput.content` holding either a data URL
 * (`data:image/png;base64,...`) or a bare base64 string (assumed JPEG).
 * Never throws — failures become `output: null` (see llm.ts parserError).
 */
import type { ParseInput, Parser, ParseResult } from "./types.ts";
import type { Clock } from "../core/clock/mod.ts";
import {
  extractReservationJson,
  parserError,
  reservationPromptForClock,
  resolveApiKey,
} from "./llm.ts";

export const GEMINI_PARSER_NAME = "gemini-flash";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const GEMINI_DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

export interface GeminiParserOptions {
  /** Defaults to the GEMINI_API_KEY environment variable, read at parse time. */
  apiKey?: string;
  /** Anchors the prompt's year-inference rule to today's JST date. */
  clock?: Clock;
  model?: string;
  /** API base URL (up to /v1beta), mainly for tests. */
  endpoint?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

/** Builds the user-turn parts for a ParseInput (text, or inline image data). */
function toParts(input: ParseInput): GeminiPart[] {
  if (input.type === "text") {
    return [{ text: input.content }];
  }
  const match = DATA_URL_RE.exec(input.content);
  const mimeType = match?.[1] ?? "image/jpeg";
  const data = match?.[2] ?? input.content;
  return [
    { text: "この画像から予約情報を抽出してください。" },
    { inlineData: { mimeType, data } },
  ];
}

export function GeminiParser(options: GeminiParserOptions = {}): Parser {
  const model = options.model ?? GEMINI_DEFAULT_MODEL;
  const endpoint = options.endpoint ?? GEMINI_DEFAULT_ENDPOINT;
  const doFetch = options.fetch ?? fetch;

  return {
    name: GEMINI_PARSER_NAME,
    supports: (input: ParseInput) => input.type === "text" || input.type === "image",
    async parse(input: ParseInput): Promise<ParseResult> {
      const apiKey = resolveApiKey(options.apiKey, GEMINI_API_KEY_ENV);
      if (apiKey === undefined) {
        return parserError(`${GEMINI_API_KEY_ENV} is not set`);
      }

      let body: string;
      try {
        const res = await doFetch(`${endpoint}/models/${model}:generateContent`, {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: reservationPromptForClock(options.clock) }] },
            contents: [{ role: "user", parts: toParts(input) }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        });
        body = await res.text();
        if (!res.ok) {
          return parserError(`gemini http ${res.status}: ${body}`);
        }
      } catch (err) {
        return parserError(
          `gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let content: string;
      try {
        const data = JSON.parse(body) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        content = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("");
      } catch {
        return parserError(`gemini returned non-JSON body: ${body}`);
      }
      if (content === "") {
        return parserError(`gemini response had no text parts: ${body}`);
      }

      // raw_response is the model's own text (SDD §3.5) — replay re-derives
      // output from it via extractReservationJson.
      return { raw_response: content, output: extractReservationJson(content) };
    },
  };
}
