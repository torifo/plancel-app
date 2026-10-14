/**
 * Gemini transport for the agent loop (generateContent with function calling).
 *
 * Vertex AI and the Gemini API take the same request/response JSON, so the agent
 * talks to one small interface and the deployment picks the wire: Vertex AI on
 * Cloud Run (service-account token from the metadata server, no key to leak),
 * the Gemini API with GEMINI_API_KEY anywhere else.
 */
import type { Clock } from "../core/clock/mod.ts";
import { postRetryingOn5xx } from "../parse/llm.ts";
import { logger } from "../lib/log.ts";

/**
 * Tried in this order. The alias is what the parsers use (ADR-13: pinned ids get retired); the
 * others answer when it is overloaded or not offered by the endpoint (a 503 on the alias was seen
 * while gemini-3-flash-preview answered, 2026-10-15).
 */
export const AGENT_DEFAULT_MODELS = [
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];
export const AGENT_DEFAULT_MODEL = AGENT_DEFAULT_MODELS[0]!;
export const VERTEX_DEFAULT_LOCATION = "asia-northeast1";
/** One generateContent attempt; a function-calling turn with thinking can take a while. */
export const AGENT_REQUEST_TIMEOUT_MS = 45_000;

export interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

/** A part is passed back to the model verbatim (Gemini 3 needs its thoughtSignature echoed). */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [extra: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface JsonSchema {
  type: "OBJECT" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN" | "ARRAY";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface GeminiRequest {
  systemInstruction: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE" } };
  generationConfig?: { temperature?: number; maxOutputTokens?: number };
}

export interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

export interface GeminiTransport {
  /** Which wire answered, recorded on every run ("vertex-ai" | "gemini-api"). */
  readonly name: string;
  readonly model: string;
  generate(req: GeminiRequest): Promise<GeminiResponse>;
  /**
   * A handle that stays on one model for a whole conversation. A model's thought signatures
   * are only valid for that model, so a run never switches models half-way.
   */
  forRun?(): GeminiTransport;
}

/** A non-2xx answer. `body` is clipped: it goes to logs and the decision log. */
export class GeminiTransportError extends Error {
  constructor(readonly transport: string, readonly status: number, body: string) {
    super(`${transport} http ${status}: ${body.slice(0, 300)}`);
    this.name = "GeminiTransportError";
  }
}

export function vertexUrl(project: string, location: string, model: string): string {
  // The "global" location has no regional host.
  const host = location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${
    encodeURIComponent(location)
  }/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

export function geminiApiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${
    encodeURIComponent(model)
  }:generateContent`;
}

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * Access token of the Cloud Run service account, from the metadata server. Cached
 * until a minute before it expires (the clock is injected, like everywhere else).
 */
export function metadataTokenProvider(
  fetchFn: typeof fetch,
  clock: Clock,
): () => Promise<string> {
  let cached: { token: string; expiresAtMs: number } | null = null;
  return async () => {
    const nowMs = clock.now().epochMilliseconds;
    if (cached !== null && nowMs < cached.expiresAtMs - 60_000) return cached.token;
    const res = await fetchFn(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`metadata token http ${res.status}`);
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("metadata token response had no access_token");
    }
    cached = { token: body.access_token, expiresAtMs: nowMs + (body.expires_in ?? 300) * 1000 };
    return cached.token;
  };
}

/** How long a 429 that says "retry in Ns" may hold a conversation before we give up on it. */
export const MAX_QUOTA_WAIT_MS = 30_000;

/** The wait a 429 asks for (RetryInfo.retryDelay, or "retry in 12.3s" in the message), in ms. */
export function quotaRetryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body) ??
    /retry in (\d+(?:\.\d+)?)s/i.exec(body);
  return m === null ? null : Math.ceil(Number(m[1]) * 1000);
}

export interface HttpTransportOptions {
  name: string;
  model: string;
  url: string;
  headers: () => Promise<Record<string, string>>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Pause before the single 5xx retry; 0 in tests. */
  retryDelayMs?: number;
  /** Longest per-minute-quota wait to sit out (see MAX_QUOTA_WAIT_MS); 0 disables it. */
  maxQuotaWaitMs?: number;
}

export class HttpGeminiTransport implements GeminiTransport {
  readonly name: string;
  readonly model: string;
  constructor(private readonly o: HttpTransportOptions) {
    this.name = o.name;
    this.model = o.model;
  }

  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    const send = async () =>
      await postRetryingOn5xx(
        this.o.fetchFn ?? fetch,
        this.o.url,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...await this.o.headers() },
          body: JSON.stringify(req),
        },
        this.o.retryDelayMs,
        this.o.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS,
      );
    let { res, body } = await send();
    // A per-minute quota says how long to wait; sitting that out beats failing a run half-way.
    // A quota with no short wait (daily, or none given) is not retried.
    if (res.status === 429) {
      const wait = quotaRetryDelayMs(body);
      if (wait !== null && wait <= (this.o.maxQuotaWaitMs ?? MAX_QUOTA_WAIT_MS)) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        ({ res, body } = await send());
      }
    }
    if (!res.ok) throw new GeminiTransportError(this.name, res.status, body);
    try {
      return JSON.parse(body) as GeminiResponse;
    } catch {
      throw new GeminiTransportError(this.name, res.status, `non-JSON body: ${body}`);
    }
  }
}

const STICKY_MS = 5 * 60_000;

/**
 * Tries the chain in order for the first turn of a conversation, then stays on whichever answered.
 * The next conversation starts with that one (for a few minutes) rather than re-learning that the
 * preferred model is down.
 */
export class FallbackTransport implements GeminiTransport {
  #preferred: { index: number; untilMs: number } | null = null;
  constructor(
    private readonly chain: readonly [GeminiTransport, ...GeminiTransport[]],
    private readonly clock?: Clock,
  ) {}

  #nowMs(): number {
    return this.clock?.now().epochMilliseconds ?? 0;
  }

  /** The chain, preferred transport first while its stickiness lasts. */
  order(): GeminiTransport[] {
    const p = this.#preferred;
    if (p === null || this.#nowMs() >= p.untilMs) return [...this.chain];
    return [this.chain[p.index]!, ...this.chain.filter((_, i) => i !== p.index)];
  }

  prefer(t: GeminiTransport): void {
    this.#preferred = { index: this.chain.indexOf(t), untilMs: this.#nowMs() + STICKY_MS };
  }

  get name(): string {
    return this.order()[0]!.name;
  }
  get model(): string {
    return this.order()[0]!.model;
  }

  forRun(): GeminiTransport {
    return new PinnedConversation(this);
  }

  generate(req: GeminiRequest): Promise<GeminiResponse> {
    return this.forRun().generate(req);
  }
}

class PinnedConversation implements GeminiTransport {
  #pinned: GeminiTransport | null = null;
  constructor(private readonly parent: FallbackTransport) {}

  get name(): string {
    return (this.#pinned ?? this.parent.order()[0]!).name;
  }
  get model(): string {
    return (this.#pinned ?? this.parent.order()[0]!).model;
  }

  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    if (this.#pinned !== null) return await this.#pinned.generate(req);
    let failure: unknown;
    let failed = false;
    for (const t of this.parent.order()) {
      try {
        const res = await t.generate(req);
        this.#pinned = t;
        this.parent.prefer(t);
        return res;
      } catch (err) {
        // The preferred model's failure is the informative one; later ones are often just "not offered".
        if (!failed) failure = err;
        failed = true;
        logger("agent.gemini").warn("transport failed, trying the next", {
          transport: t.name,
          model: t.model,
          err: String(err).slice(0, 160),
        });
      }
    }
    throw failure;
  }
}

interface EnvGet {
  get(key: string): string | undefined;
}

/**
 * The transport this deployment is configured for, or null when neither Vertex
 * nor an API key is set (the agent is then reported as not configured).
 *
 *   PLANCEL_VERTEX_PROJECT (+ PLANCEL_VERTEX_LOCATION)  → Vertex AI, Cloud Run's service account
 *   GEMINI_API_KEY                                      → Gemini API
 *
 * PLANCEL_AGENT_MODEL is one model id or a comma-separated list, tried in order. With both
 * wires set, every model is tried on Vertex before the API key is used.
 */
export function selectTransport(
  env: EnvGet,
  deps: { fetchFn?: typeof fetch; clock: Clock; retryDelayMs?: number },
): GeminiTransport | null {
  const fetchFn = deps.fetchFn ?? fetch;
  const listed = (env.get("PLANCEL_AGENT_MODEL") ?? "").split(",").map((m) => m.trim()).filter(
    Boolean,
  );
  const models = listed.length > 0 ? listed : AGENT_DEFAULT_MODELS;
  const retry = deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {};
  const chain: GeminiTransport[] = [];

  const project = env.get("PLANCEL_VERTEX_PROJECT")?.trim();
  if (project) {
    const location = env.get("PLANCEL_VERTEX_LOCATION")?.trim() || VERTEX_DEFAULT_LOCATION;
    const token = metadataTokenProvider(fetchFn, deps.clock);
    for (const model of models) {
      chain.push(
        new HttpGeminiTransport({
          name: "vertex-ai",
          model,
          url: vertexUrl(project, location, model),
          headers: async () => ({ authorization: `Bearer ${await token()}` }),
          fetchFn,
          ...retry,
        }),
      );
    }
  }
  const apiKey = env.get("GEMINI_API_KEY")?.trim();
  if (apiKey) {
    for (const model of models) {
      chain.push(
        new HttpGeminiTransport({
          name: "gemini-api",
          model,
          url: geminiApiUrl(model),
          headers: () => Promise.resolve({ "x-goog-api-key": apiKey }),
          fetchFn,
          ...retry,
        }),
      );
    }
  }
  if (chain.length === 0) return null;
  if (chain.length === 1) return chain[0]!;
  return new FallbackTransport(chain as [GeminiTransport, ...GeminiTransport[]], deps.clock);
}
