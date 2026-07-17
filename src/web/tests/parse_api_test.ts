import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { handleParseApi, mapPolicyToPreset, type ParseApiDeps } from "../parse-api.ts";
import { MockParser } from "../../parse/mod.ts";
import type { Parser } from "../../parse/mod.ts";
import type { ParseJob } from "../../core/schema/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";

function makeDeps(parsers: Parser[]) {
  let n = 0;
  const jobs: ParseJob[] = [];
  const deps: ParseApiDeps = {
    parsers,
    chainConfig: { text: ["p1"], image: ["v1"] },
    clock: new VirtualClock("2026-07-16T00:00:00Z"),
    ids: {
      ulid: () => `JAB${String(++n).padStart(23, "0")}`,
      nowIso: () => "2026-07-16T00:00:00.000Z",
    },
    saveJob: (j) => {
      jobs.push(j);
      return Promise.resolve();
    },
  };
  return { deps, jobs };
}

const reqOf = (body: unknown, token: string | null = "t") =>
  new Request("http://localhost/api/parse", {
    method: "POST",
    headers: token !== null ? { "x-plancel-token": token } : {},
    body: JSON.stringify(body),
  });

Deno.test("mapPolicyToPreset: folds parsed stage arrays into web presets", () => {
  assertEquals(mapPolicyToPreset("unknown"), "unknown");
  assertEquals(mapPolicyToPreset(null), "unknown");
  assertEquals(mapPolicyToPreset({ stages: [] }), "unknown");
  assertEquals(
    mapPolicyToPreset({ stages: [{ until_offset_hours: 0, fee_percent: 0, fee_fixed_jpy: null }] }),
    "none",
  );
  assertEquals(
    mapPolicyToPreset({
      stages: [
        { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
      ],
    }),
    "free24",
  );
  assertEquals(
    mapPolicyToPreset({
      stages: [
        { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 72, fee_percent: 30, fee_fixed_jpy: null },
        { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
      ],
    }),
    "staged",
  );
});

Deno.test("parse api: missing token -> 400", async () => {
  const { deps } = makeDeps([]);
  const res = await handleParseApi(reqOf({ type: "text", content: "x" }, null), deps);
  assertEquals(res.status, 400);
});

Deno.test("parse api: pasted mail -> parsed fields mapped to the web shape", async () => {
  const mail = "【予約確認】鮨さいとう 8/15 19:00 2名 33,000円 前日まで無料";
  const p1 = MockParser(
    "p1",
    new Map([[mail, {
      raw_response: "{}",
      output: {
        service_name: "鮨さいとう 東京店",
        starts_at: "2026-08-15T19:00:00+09:00",
        amount_jpy: 33000,
        location: "東京都中央区銀座1-2-3",
        cancellation_policy: {
          stages: [
            { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null },
            { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
          ],
        },
      },
    }]]),
  );
  const { deps, jobs } = makeDeps([p1]);

  const res = await handleParseApi(reqOf({ type: "text", content: mail }), deps);
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.status, "parsed");
  assertEquals(body.fields.service, "鮨さいとう 東京店");
  assertEquals(body.fields.startsAt, "2026-08-15T19:00:00+09:00");
  assertEquals(body.fields.amount, 33000);
  assertEquals(body.fields.policy, "free24");
  assertEquals(body.fields.location, "東京都中央区銀座1-2-3");
  assertEquals(jobs.length, 1); // ParseJob saved for the replay corpus
});

Deno.test("parse api: unparseable text -> status failed (UI falls back to manual)", async () => {
  const { deps } = makeDeps([MockParser("p1", new Map())]);
  const res = await handleParseApi(reqOf({ type: "text", content: "？？？" }), deps);
  const body = await res.json();
  assertEquals(body.status, "failed");
  assertEquals(body.fields.service, null);
});

Deno.test("parse api: missing fields -> needs_review with the missing list", async () => {
  const text = "どこかで食事";
  const p1 = MockParser(
    "p1",
    new Map([[text, { raw_response: "{}", output: { service_name: "どこか" } }]]),
  );
  const { deps } = makeDeps([p1]);
  const body = await (await handleParseApi(reqOf({ type: "text", content: text }), deps)).json();
  assertEquals(body.status, "needs_review");
  assertEquals(body.missing.length > 0, true);
  assertEquals(body.fields.service, "どこか"); // partial prefill still returned
});

Deno.test("parse api: image content routes through the image chain (vision)", async () => {
  const v1 = MockParser("v1", (input) =>
    input.type === "image"
      ? {
        raw_response: "{}",
        output: { service_name: "宿", starts_at: "2026-09-01T15:00:00+09:00" },
      }
      : undefined);
  const { deps } = makeDeps([v1]);
  const body = await (await handleParseApi(
    reqOf({ type: "image", content: "data:image/jpeg;base64,AAAA" }),
    deps,
  )).json();
  assertEquals(body.status, "parsed");
  assertEquals(body.fields.service, "宿");
});
