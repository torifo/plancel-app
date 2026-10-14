import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import {
  AGENT_DEFAULT_MODEL,
  FallbackTransport,
  geminiApiUrl,
  type GeminiRequest,
  type GeminiResponse,
  GeminiTransportError,
  HttpGeminiTransport,
  metadataTokenProvider,
  quotaRetryDelayMs,
  selectTransport,
  vertexUrl,
} from "../gemini.ts";

const REQ: GeminiRequest = {
  systemInstruction: { parts: [{ text: "sys" }] },
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
};
const OK: GeminiResponse = {
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
};
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });

interface Seen {
  url: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that answers the metadata server and the model, and remembers what it was asked. */
function fakeFetch(opts: { modelStatus?: number } = {}) {
  const seen: Seen[] = [];
  let tokens = 0;
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith("http://metadata.google.internal/")) {
      tokens++;
      seen.push({ url, headers, body: null });
      return Promise.resolve(
        Response.json({
          access_token: `ya29.token${tokens}`,
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    }
    seen.push({ url, headers, body: JSON.parse(String(init?.body)) });
    const status = opts.modelStatus ?? 200;
    return Promise.resolve(status === 200 ? Response.json(OK) : new Response("denied", { status }));
  };
  return { fetchFn, seen, tokenFetches: () => tokens };
}

Deno.test("Vertex URL: regional host for a region, the global host for global", () => {
  assertEquals(
    vertexUrl("my-proj", "asia-northeast1", "gemini-x"),
    "https://asia-northeast1-aiplatform.googleapis.com/v1/projects/my-proj/locations/asia-northeast1/publishers/google/models/gemini-x:generateContent",
  );
  assertEquals(
    vertexUrl("my-proj", "global", "gemini-x"),
    "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/gemini-x:generateContent",
  );
  assertEquals(
    geminiApiUrl("gemini-flash-latest"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
  );
});

Deno.test("with PLANCEL_VERTEX_PROJECT the agent calls Vertex AI with the service-account token", async () => {
  const f = fakeFetch();
  const clock = new VirtualClock("2026-10-15T00:00:00Z");
  const t = selectTransport(
    env({ PLANCEL_VERTEX_PROJECT: "proj-1", PLANCEL_AGENT_MODEL: "gemini-3.5-flash" }),
    { fetchFn: f.fetchFn, clock },
  )!;
  assertEquals(t.name, "vertex-ai");
  assertEquals(t.model, "gemini-3.5-flash");
  await t.generate(REQ);

  const [meta, call] = f.seen;
  assertEquals(meta!.headers.get("Metadata-Flavor"), "Google");
  assertStringIncludes(call!.url, "asia-northeast1-aiplatform.googleapis.com");
  assertStringIncludes(call!.url, "/projects/proj-1/");
  assertStringIncludes(call!.url, "models/gemini-3.5-flash:generateContent");
  assertEquals(call!.headers.get("authorization"), "Bearer ya29.token1");
  assertEquals(call!.headers.get("x-goog-api-key"), null);
  assertEquals((call!.body as GeminiRequest).contents[0]!.parts[0]!.text, "hi");
});

Deno.test("the metadata token is cached until a minute before it expires, then renewed", async () => {
  const f = fakeFetch();
  const clock = new VirtualClock("2026-10-15T00:00:00Z");
  const token = metadataTokenProvider(f.fetchFn, clock);
  assertEquals(await token(), "ya29.token1");
  clock.advance("PT58M");
  assertEquals(await token(), "ya29.token1");
  assertEquals(f.tokenFetches(), 1);
  clock.advance("PT2M");
  assertEquals(await token(), "ya29.token2");
});

Deno.test("without Vertex the agent uses the Gemini API key, default model, and a location override", async () => {
  const f = fakeFetch();
  const clock = new VirtualClock("2026-10-15T00:00:00Z");
  const t = selectTransport(env({ GEMINI_API_KEY: "k-test" }), { fetchFn: f.fetchFn, clock })!;
  assertEquals(t.name, "gemini-api");
  assertEquals(t.model, AGENT_DEFAULT_MODEL);
  await t.generate(REQ);
  assertEquals(f.seen[0]!.headers.get("x-goog-api-key"), "k-test");
  assertStringIncludes(f.seen[0]!.url, "generativelanguage.googleapis.com");
  assert(!f.seen[0]!.url.includes("k-test"), "the key must never ride in the URL");

  const g = fakeFetch();
  const v = selectTransport(
    env({ PLANCEL_VERTEX_PROJECT: "p", PLANCEL_VERTEX_LOCATION: "global" }),
    { fetchFn: g.fetchFn, clock },
  )!;
  await v.generate(REQ);
  assertStringIncludes(g.seen[1]!.url, "https://aiplatform.googleapis.com/");
});

Deno.test("no Vertex project and no key means no agent", () => {
  const clock = new VirtualClock("2026-10-15T00:00:00Z");
  assertEquals(selectTransport(env({}), { clock }), null);
  assertEquals(selectTransport(env({ GEMINI_API_KEY: "  " }), { clock }), null);
});

Deno.test("Vertex first, the API key as fallback; the wire that answered is the one reported", async () => {
  const seen: string[] = [];
  const fetchFn: typeof fetch = (input) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("http://metadata")) {
      return Promise.resolve(Response.json({ access_token: "t", expires_in: 3600 }));
    }
    return Promise.resolve(
      url.includes("aiplatform") ? new Response("denied", { status: 403 }) : Response.json(OK),
    );
  };
  const clock = new VirtualClock("2026-10-15T00:00:00Z");
  const t = selectTransport(
    env({ PLANCEL_VERTEX_PROJECT: "p", GEMINI_API_KEY: "k", PLANCEL_AGENT_MODEL: "m1" }),
    { fetchFn, clock },
  )!;
  assert(t instanceof FallbackTransport);
  assertEquals(t.name, "vertex-ai");
  const conversation = t.forRun!();
  await conversation.generate(REQ);
  assertEquals(conversation.name, "gemini-api");
  assertEquals(conversation.model, "m1");
  assertEquals(seen.filter((u) => u.includes("generateContent")).length, 2);
});

Deno.test("a list of models: the first that answers is kept for the whole conversation, then preferred for a while", async () => {
  const seen: string[] = [];
  const fetchFn: typeof fetch = (input) => {
    const url = String(input);
    seen.push(url.match(/models\/([^:]+):/)![1]!);
    return Promise.resolve(
      url.includes("overloaded") ? new Response("busy", { status: 503 }) : Response.json(OK),
    );
  };
  const clock = new VirtualClock("2026-10-15T00:00:00Z");
  const t = selectTransport(
    env({ GEMINI_API_KEY: "k", PLANCEL_AGENT_MODEL: "overloaded, steady ,spare" }),
    { fetchFn, clock, retryDelayMs: 0 },
  )!;

  const first = t.forRun!();
  await first.generate(REQ);
  // The 503 was retried once, then the next model answered.
  assertEquals(seen, ["overloaded", "overloaded", "steady"]);
  assertEquals(first.model, "steady");
  await first.generate(REQ);
  await first.generate(REQ);
  assertEquals(seen.slice(3), ["steady", "steady"]);

  // The next conversation does not re-try the model that was down.
  seen.length = 0;
  await t.forRun!().generate(REQ);
  assertEquals(seen, ["steady"]);

  // Once the stickiness lapses the preferred model gets another chance.
  clock.advance("PT6M");
  seen.length = 0;
  await t.forRun!().generate(REQ);
  assertEquals(seen[0], "overloaded");
});

Deno.test("every model failing surfaces the preferred model's error, not a later model's 404", async () => {
  const fetchFn: typeof fetch = (input) =>
    Promise.resolve(
      String(input).includes("/a:")
        ? new Response("busy", { status: 429 })
        : new Response("gone", { status: 404 }),
    );
  const t = selectTransport(env({ GEMINI_API_KEY: "k", PLANCEL_AGENT_MODEL: "a,b" }), {
    fetchFn,
    clock: new VirtualClock("2026-10-15T00:00:00Z"),
  })!;
  const err = await assertRejects(() => t.generate(REQ), GeminiTransportError);
  assertEquals(err.status, 429);
});

Deno.test("an HTTP error carries the status and a clipped body, never the credential", async () => {
  const t = new HttpGeminiTransport({
    name: "gemini-api",
    model: "m",
    url: "https://example.test/x",
    headers: () => Promise.resolve({ "x-goog-api-key": "SECRET-KEY" }),
    fetchFn: () => Promise.resolve(new Response("x".repeat(2000), { status: 429 })),
  });
  const err = await assertRejects(() => t.generate(REQ), GeminiTransportError);
  assertEquals(err.status, 429);
  assert(err.message.length < 400);
  assert(!err.message.includes("SECRET-KEY"));
});

Deno.test("a 5xx is retried once, a 429 is not", async () => {
  let calls = 0;
  const flaky = new HttpGeminiTransport({
    name: "n",
    model: "m",
    url: "https://example.test/x",
    headers: () => Promise.resolve({}),
    retryDelayMs: 0,
    fetchFn: () =>
      Promise.resolve(++calls === 1 ? new Response("busy", { status: 503 }) : Response.json(OK)),
  });
  await flaky.generate(REQ);
  assertEquals(calls, 2);

  calls = 0;
  const quota = new HttpGeminiTransport({
    name: "n",
    model: "m",
    url: "https://example.test/x",
    headers: () => Promise.resolve({}),
    retryDelayMs: 0,
    fetchFn: () => Promise.resolve(new Response("quota", { status: ++calls && 429 })),
  });
  await assertRejects(() => quota.generate(REQ), GeminiTransportError);
  assertEquals(calls, 1);
});

Deno.test("a 429 that names a short wait is sat out once; a long or unstated one is not", async () => {
  assertEquals(quotaRetryDelayMs('{"error":{"details":[{"retryDelay":"17s"}]}}'), 17_000);
  assertEquals(quotaRetryDelayMs("Please retry in 2.5s."), 2_500);
  assertEquals(quotaRetryDelayMs("You exceeded your current quota"), null);

  const make = (bodyOf429: string, calls: { n: number }) =>
    new HttpGeminiTransport({
      name: "n",
      model: "m",
      url: "https://example.test/x",
      headers: () => Promise.resolve({}),
      retryDelayMs: 0,
      maxQuotaWaitMs: 50,
      fetchFn: () =>
        Promise.resolve(
          ++calls.n === 1 ? new Response(bodyOf429, { status: 429 }) : Response.json(OK),
        ),
    });

  const short = { n: 0 };
  await make('{"error":{"details":[{"retryDelay":"0.01s"}]}}', short).generate(REQ);
  assertEquals(short.n, 2);

  const long = { n: 0 };
  await assertRejects(
    () => make('{"error":{"details":[{"retryDelay":"3600s"}]}}', long).generate(REQ),
    GeminiTransportError,
  );
  assertEquals(long.n, 1);

  const unstated = { n: 0 };
  await assertRejects(() => make("quota exceeded", unstated).generate(REQ), GeminiTransportError);
  assertEquals(unstated.n, 1);
});
