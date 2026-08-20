import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { handleParseApi, type ParseApiDeps } from "../parse-api.ts";
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
        ends_at: "2026-08-15T21:30:00+09:00",
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
  // モデルが読み取った終了日時はフォームまで運ぶ（終わった予約の判定に使う）。
  assertEquals(body.fields.endsAt, "2026-08-15T21:30:00+09:00");
  assertEquals(body.fields.amount, 33000);
  assertEquals(body.fields.policy, "free24");
  assertEquals(body.fields.location, "東京都中央区銀座1-2-3");
  assertEquals(jobs.length, 1); // ParseJob saved for the replay corpus
});

// 「5日前まで無料」 has no preset — before 2026-07-27 it was flattened to
// "staged" (7日前) and the UI's deadline lied. It now reaches the form as-is.
Deno.test("parse api: a nonstandard policy keeps its own stages", async () => {
  const mail = "【予約確認】翠嶺館 8/20 15:00 5日前まで無料、以降30%、当日100%";
  const p1 = MockParser(
    "p1",
    new Map([[mail, {
      raw_response: "{}",
      output: {
        service_name: "翠嶺館",
        starts_at: "2026-08-20T15:00:00+09:00",
        cancellation_policy: {
          stages: [
            { until_offset_hours: 120, fee_percent: 0, fee_fixed_jpy: null },
            { until_offset_hours: 72, fee_percent: 30, fee_fixed_jpy: null },
            { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
          ],
        },
      },
    }]]),
  );
  const { deps } = makeDeps([p1]);
  const body = await (await handleParseApi(reqOf({ type: "text", content: mail }), deps)).json();
  assertEquals(body.fields.policy, {
    stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }, { h: 0, pct: 100 }],
  });
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

// ADR-13: a provider that stopped answering used to be indistinguishable from
// a mail nobody could read — same 200, same "failed", and nothing in the log.
Deno.test("parse api: no provider answered -> reason unavailable, logged as an error", async () => {
  const text = "8/15 19:00 鮨さいとう";
  const dead = MockParser(
    "p1",
    new Map([[text, { raw_response: "error: groq http 404: model_not_found", output: null }]]),
  );
  const lines: string[] = [];
  const { deps } = makeDeps([dead]);
  deps.logWrite = (line) => lines.push(line);

  const body = await (await handleParseApi(reqOf({ type: "text", content: text }), deps)).json();

  assertEquals(body.status, "failed");
  assertEquals(body.reason, "unavailable");
  assertEquals(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assertEquals(record.level, "error");
  assertEquals(record.component, "web.parse");
  assertEquals(record.failures, [{ parser: "p1", error: "groq http 404: model_not_found" }]);
});

Deno.test("parse api: a model that read nothing -> reason unreadable", async () => {
  const lines: string[] = [];
  const { deps } = makeDeps([MockParser("p1", new Map())]);
  deps.logWrite = (line) => lines.push(line);

  const body = await (await handleParseApi(reqOf({ type: "text", content: "？？？" }), deps))
    .json();

  assertEquals(body.status, "failed");
  assertEquals(body.reason, "unreadable");
  assertEquals(JSON.parse(lines[0]!).level, "info");
});

Deno.test("parse api: a parsed job says nothing about a reason", async () => {
  const text = "8/15 19:00 鮨さいとう";
  const p1 = MockParser(
    "p1",
    new Map([[text, {
      raw_response: "{}",
      output: { service_name: "鮨さいとう", starts_at: "2026-08-15T19:00:00+09:00" },
    }]]),
  );
  const { deps } = makeDeps([p1]);

  const body = await (await handleParseApi(reqOf({ type: "text", content: text }), deps)).json();

  assertEquals(body.status, "parsed");
  assertEquals(body.reason, null);
});
