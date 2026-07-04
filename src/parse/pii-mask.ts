/**
 * PII masking — mandatory pre-processing before any parser (SDD §5 プライバシー).
 *
 * Free-tier LLMs (e.g. Gemini free quota) may retain input for training, so
 * phone numbers and email addresses must be masked before any text leaves
 * the process. This is a purely mechanical, non-LLM transform: it must run
 * before `runParseChain` hands input to a Parser (see chain.ts).
 */

export type PiiKind = "phone" | "email";

export interface PiiMatch {
  kind: PiiKind;
  original: string;
}

export interface PiiMaskResult {
  masked: string;
  found: PiiMatch[];
}

// Japanese phone formats: 0X0-XXXX-XXXX / 0X-XXXX-XXXX / 0XX0-XXX-XXX,
// +81 international form, and unhyphenated 10-11 digit domestic numbers.
const PHONE_RE =
  /(?:\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})|(?:0\d{1,4}-\d{1,4}-\d{3,4})|(?:0\d{9,10})/g;

const EMAIL_RE = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/g;

/**
 * Masks phone numbers and email addresses in `text`, replacing each match
 * with a stable placeholder token and returning the originals for logging
 * (never sent onward — only for local audit/debugging).
 */
export function maskPii(text: string): PiiMaskResult {
  const found: PiiMatch[] = [];

  // Emails first: an email's local part could otherwise be mistaken for
  // digits by the phone regex in pathological inputs.
  let masked = text.replace(EMAIL_RE, (match) => {
    found.push({ kind: "email", original: match });
    return `[MASKED_EMAIL_${found.length}]`;
  });

  masked = masked.replace(PHONE_RE, (match) => {
    found.push({ kind: "phone", original: match });
    return `[MASKED_PHONE_${found.length}]`;
  });

  return { masked, found };
}
