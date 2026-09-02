/**
 * Provider canary — asks each parser one tiny question on a schedule, so a
 * retired model is found by the app rather than by a family member (ADR-13).
 *
 * The whole point is to tell apart the two failures the chain deliberately
 * blurs. `runParseChain` turns any provider failure into `output: null` and
 * falls through, which is right for a person pasting a mail — one dead
 * provider should not cost them their reservation. It is wrong as the only
 * signal, because a provider that has stopped answering then looks exactly
 * like an unreadable mail, forever.
 *
 * So the canary does NOT use the chain. It asks each parser separately and
 * reports the ones that failed, by name.
 *
 * What it sends is a fixed, invented one-line reservation with no PII in it.
 * The answer only has to come back; whether the model read it well is the
 * replay corpus's job, not this one's. A single parse costs roughly 1.5K
 * tokens against a per-minute budget of 8,000, once a day.
 *
 * Faults come back classified (see `classifyFault`): only the structural ones
 * are worth waking anyone for.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { ParseInput, Parser } from "./types.ts";

/**
 * Deliberately dull and fictional: this text reaches a third party once a
 * day, so it must never be anyone's actual booking. The date is written in
 * the year-less form real mails use, exercising the same prompt path.
 */
export const CANARY_TEXT = "予約確認 8月1日 19:00 テスト食堂 2名 5,000円 前日まで無料";

/** How stale a check may be before it is worth spending the tokens again. */
export const CANARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a fault means the setup is wrong, or just that the provider was
 * having a bad minute.
 *
 * The difference decides whether anyone is told. A model that no longer
 * exists answers 404 every time and needs a person; Gemini answering 503
 * "experiencing high demand", or taking longer than the deadline, is normal
 * and self-healing. Filing the second kind daily would teach the developer
 * to skim past the list, which is the failure mode this whole thing exists
 * to prevent.
 */
export type CanaryFaultKind = "structural" | "transient";

export interface CanaryFault {
  parser: string;
  kind: CanaryFaultKind;
  /** The provider's own words, without the `error: ` prefix. */
  error: string;
}

export interface CanaryResult {
  checked: string[];
  faults: CanaryFault[];
}

const PROVIDER_ERROR_PREFIX = "error: ";

/**
 * Classifies a provider failure.
 *
 * A 4xx is the provider saying the request itself is wrong — a retired model
 * (404 model_not_found), a rejected key (401/403). Those do not fix
 * themselves. A 5xx, an aborted request and a network error are the
 * provider or the wire, and the next attempt usually works.
 */
export function classifyFault(error: string): CanaryFaultKind {
  const status = /\bhttp (\d{3})\b/.exec(error)?.[1];
  if (status !== undefined) return status.startsWith("4") ? "structural" : "transient";
  // Missing key, or a response shape nothing can be read out of: both mean
  // someone has to look.
  if (/is not set|no text parts|non-JSON body|nothing was extractable/.test(error)) {
    return "structural";
  }
  return "transient";
}

/**
 * Asks every parser the canary question and returns the ones that could not
 * answer. Never throws: a parser that breaks its own contract and throws is
 * itself reported as a fault, since that is exactly as broken.
 *
 * An empty `faults` means every parser answered — not that the answers were
 * any good.
 */
export async function runCanary(parsers: Parser[], clock: Clock): Promise<CanaryResult> {
  const input: ParseInput = {
    type: "text",
    content: CANARY_TEXT,
    correlation_id: `canary-${clock.now().epochMilliseconds}`,
  };
  const checked: string[] = [];
  const faults: CanaryFault[] = [];
  for (const parser of parsers) {
    if (!parser.supports(input)) continue;
    checked.push(parser.name);
    try {
      const result = await parser.parse(input);
      if (result.output !== null) continue;
      if (result.raw_response.startsWith(PROVIDER_ERROR_PREFIX)) {
        const error = result.raw_response.slice(PROVIDER_ERROR_PREFIX.length);
        faults.push({ parser: parser.name, kind: classifyFault(error), error });
        continue;
      }
      // The provider answered, but nothing could be read out of a sentence
      // this plain. Something upstream changed — a refusal, a new envelope,
      // a model that stopped honouring the JSON format.
      faults.push({
        parser: parser.name,
        kind: "structural",
        error: `answered but nothing was extractable: ${result.raw_response.slice(0, 300)}`,
      });
    } catch (err) {
      // A parser is contractually forbidden from throwing, so one that does
      // is a defect in our code, not a bad minute at the provider.
      faults.push({
        parser: parser.name,
        kind: "structural",
        error: `threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { checked, faults };
}
