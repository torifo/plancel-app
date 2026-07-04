/**
 * Parser abstraction (SDD §5, FR-011, design.md parse/pipeline).
 *
 * Every parse entry point (text or image, from MCP/LINE/manual) is
 * normalized into a `ParseInput` before being handed to a chain of
 * `Parser` implementations (see chain.ts). Concrete parsers (Groq, Gemini,
 * or `MockParser` for development/tests) never see the entry point's
 * transport details — only this shape.
 */
import type { Reservation } from "../core/schema/mod.ts";

export type ParseInputType = "text" | "image";

export interface ParseInput {
  type: ParseInputType;
  /** Raw text, or an image reference/base64 payload, depending on `type`. */
  content: string;
  /** Ties this parse attempt to structured logs and the eventual ParseJob. */
  correlation_id: string;
}

export interface ParseResult {
  /** The parser's full, unmodified response — always saved (SDD §10.4). */
  raw_response: string;
  /** Best-effort extracted fields, or `null` if nothing could be extracted. */
  output: Partial<Reservation> | null;
}

export interface Parser {
  /** Stable identifier recorded in ParseAttempt.parser (e.g. "groq-llama"). */
  name: string;
  /** Whether this parser can handle the given input (e.g. vision-only). */
  supports(input: ParseInput): boolean;
  parse(input: ParseInput): Promise<ParseResult>;
}
