import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { GeminiParser } from "../gemini.ts";
import type { ParseInput } from "../types.ts";

const TEXT_INPUT: ParseInput = {
  type: "text",
  content: "8/1 19時 〇〇レストラン 8000円",
  correlation_id: "corr-gemini",
};

interface GeminiRequestBody {
  systemInstruction: { parts: { text: string }[] };
  contents: {
    role: string;
    parts: { text?: string; inlineData?: { mimeType: string; data: string } }[];
  }[];
  generationConfig: { temperature: number; responseMimeType: string };
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetch: typeof fetch; calls: { url: string; body: GeminiRequestBody }[] } {
  const calls: { url: string; body: GeminiRequestBody }[] = [];
  const fetchStub = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as GeminiRequestBody });
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200 },
  );
}

Deno.test("GeminiParser: text success — output extracted, model/endpoint correct", async () => {
  const content = '{"service_name":"〇〇レストラン","amount_jpy":8000}';
  const { fetch, calls } = stubFetch(() => geminiResponse(content));
  const result = await GeminiParser({ apiKey: "k", fetch }).parse(TEXT_INPUT);

  assertEquals(result.raw_response, content);
  assertEquals(result.output, { service_name: "〇〇レストラン", amount_jpy: 8000 });
  assertStringIncludes(calls[0]?.url ?? "", "models/gemini-flash-latest:generateContent");
  assertEquals(calls[0]?.body.generationConfig.responseMimeType, "application/json");
  assertEquals(calls[0]?.body.contents[0]?.parts[0]?.text, TEXT_INPUT.content);
});

Deno.test("GeminiParser: image input — data URL becomes inlineData with its mime type", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse('{"service_name":"a"}'));
  const input: ParseInput = {
    type: "image",
    content: "data:image/png;base64,AAAA",
    correlation_id: "corr-img",
  };
  await GeminiParser({ apiKey: "k", fetch }).parse(input);

  const parts = calls[0]?.body.contents[0]?.parts ?? [];
  const inline = parts.find((p) => p.inlineData)?.inlineData;
  assertEquals(inline, { mimeType: "image/png", data: "AAAA" });
});

Deno.test("GeminiParser: image input — bare base64 defaults to image/jpeg", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse('{"service_name":"a"}'));
  await GeminiParser({ apiKey: "k", fetch }).parse({
    type: "image",
    content: "BBBB",
    correlation_id: "corr-img2",
  });

  const inline = (calls[0]?.body.contents[0]?.parts ?? []).find((p) => p.inlineData)?.inlineData;
  assertEquals(inline, { mimeType: "image/jpeg", data: "BBBB" });
});

Deno.test("GeminiParser: multi-part response text is concatenated", async () => {
  const { fetch } = stubFetch(() =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"service_' }, { text: 'name":"a"}' }] } }],
      }),
      { status: 200 },
    )
  );
  const result = await GeminiParser({ apiKey: "k", fetch }).parse(TEXT_INPUT);
  assertEquals(result.output, { service_name: "a" });
});

Deno.test("GeminiParser: HTTP error -> output null, error recorded (never throws)", async () => {
  const { fetch } = stubFetch(() => new Response("quota exceeded", { status: 429 }));
  const result = await GeminiParser({ apiKey: "k", fetch }).parse(TEXT_INPUT);
  assertEquals(result.output, null);
  assertStringIncludes(result.raw_response, "gemini http 429");
});

Deno.test("GeminiParser: missing API key -> output null, no request made", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse("{}"));
  const previous = Deno.env.get("GEMINI_API_KEY");
  Deno.env.delete("GEMINI_API_KEY");
  try {
    const result = await GeminiParser({ fetch }).parse(TEXT_INPUT);
    assertEquals(result.output, null);
    assertStringIncludes(result.raw_response, "GEMINI_API_KEY");
    assertEquals(calls.length, 0);
  } finally {
    if (previous !== undefined) Deno.env.set("GEMINI_API_KEY", previous);
  }
});

Deno.test("GeminiParser: supports both text and image (vision-pinned route)", () => {
  const parser = GeminiParser({ apiKey: "k" });
  assertEquals(parser.supports({ type: "text", content: "x", correlation_id: "c" }), true);
  assertEquals(parser.supports({ type: "image", content: "x", correlation_id: "c" }), true);
});
