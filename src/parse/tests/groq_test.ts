import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { GroqParser } from "../groq.ts";
import type { ParseInput } from "../types.ts";

const TEXT_INPUT: ParseInput = {
  type: "text",
  content: "8/1 19時 〇〇レストラン 8000円",
  correlation_id: "corr-groq",
};

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetch: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchStub = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function groqResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

Deno.test("GroqParser: success — output extracted, raw_response is the model text", async () => {
  const content = '{"service_name":"〇〇レストラン","starts_at":"2026-08-01T19:00:00+09:00"}';
  const { fetch, calls } = stubFetch(() => groqResponse(content));
  const parser = GroqParser({ apiKey: "k", fetch });

  const result = await parser.parse(TEXT_INPUT);

  assertEquals(result.raw_response, content);
  assertEquals(result.output, {
    service_name: "〇〇レストラン",
    starts_at: "2026-08-01T19:00:00+09:00",
  });
  const body = calls[0]?.body as {
    model: string;
    messages: { role: string; content: string }[];
    response_format: { type: string };
  };
  assertEquals(body.model, "llama-3.3-70b-versatile");
  assertEquals(body.response_format.type, "json_object");
  assertEquals(body.messages[1]?.content, TEXT_INPUT.content);
});

Deno.test("GroqParser: HTTP error -> output null, error recorded (never throws)", async () => {
  const { fetch } = stubFetch(() => new Response("rate limited", { status: 429 }));
  const result = await GroqParser({ apiKey: "k", fetch }).parse(TEXT_INPUT);
  assertEquals(result.output, null);
  assertStringIncludes(result.raw_response, "groq http 429");
});

Deno.test("GroqParser: network failure -> output null (never throws)", async () => {
  const failing = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  const result = await GroqParser({ apiKey: "k", fetch: failing }).parse(TEXT_INPUT);
  assertEquals(result.output, null);
  assertStringIncludes(result.raw_response, "connection refused");
});

Deno.test("GroqParser: missing API key -> output null, no request made", async () => {
  const { fetch, calls } = stubFetch(() => groqResponse("{}"));
  const parser = GroqParser({ fetch }); // no apiKey; GROQ_API_KEY not set in test env
  const previous = Deno.env.get("GROQ_API_KEY");
  Deno.env.delete("GROQ_API_KEY");
  try {
    const result = await parser.parse(TEXT_INPUT);
    assertEquals(result.output, null);
    assertStringIncludes(result.raw_response, "GROQ_API_KEY");
    assertEquals(calls.length, 0);
  } finally {
    if (previous !== undefined) Deno.env.set("GROQ_API_KEY", previous);
  }
});

Deno.test("GroqParser: text-only — supports() rejects images", () => {
  const parser = GroqParser({ apiKey: "k" });
  assertEquals(parser.supports({ type: "text", content: "x", correlation_id: "c" }), true);
  assertEquals(parser.supports({ type: "image", content: "x", correlation_id: "c" }), false);
});
