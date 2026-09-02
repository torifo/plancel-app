import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { MockParser } from "../../parse/mod.ts";
import { CANARY_TEXT } from "../../parse/canary.ts";
import { sweepCanary } from "../canary-watch.ts";
import { listReports, type ReportsDeps } from "../reports.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

function reportsDeps(kv: Deno.Kv, lines: string[] = []): ReportsDeps {
  let n = 0;
  return {
    kv,
    ids: {
      ulid: () => `REP${String(++n).padStart(23, "0")}`,
      nowIso: () => "2026-08-20T06:00:00.000Z",
    },
    adminEmails: new Set<string>(),
    logWrite: (line) => lines.push(line),
  };
}

const answers = MockParser(
  "gemini-flash",
  new Map([[CANARY_TEXT, { raw_response: "{}", output: { service_name: "テスト食堂" } }]]),
);
const dead = MockParser(
  "groq-llama",
  new Map([[CANARY_TEXT, { raw_response: "error: groq http 404: model_not_found", output: null }]]),
);

Deno.test("canary watch: a dead provider becomes a system report", async () => {
  await withKv(async (kv) => {
    const reports = reportsDeps(kv);
    const sweep = await sweepCanary({
      clock: new VirtualClock("2026-08-20T00:00:00Z"),
      parsers: [dead, answers],
      reports,
    });
    assertEquals(sweep, { ran: true, checked: ["groq-llama", "gemini-flash"], faults: 1 });

    const stored = await listReports(kv);
    assertEquals(stored.length, 1);
    assertEquals(stored[0]?.kind, "system");
    assertEquals(stored[0]?.code, "parser_unreachable");
    assertEquals(stored[0]?.path, "groq-llama");
    assertEquals(stored[0]?.note, "groq http 404: model_not_found");
  });
});

Deno.test("canary watch: healthy providers file nothing", async () => {
  await withKv(async (kv) => {
    const sweep = await sweepCanary({
      clock: new VirtualClock("2026-08-20T00:00:00Z"),
      parsers: [answers],
      reports: reportsDeps(kv),
    });
    assertEquals(sweep.ran, true);
    assertEquals(sweep.faults, 0);
    assertEquals(await listReports(kv), []);
  });
});

Deno.test("canary watch: the every-15-minutes cron only asks once a day", async () => {
  await withKv(async (kv) => {
    const reports = reportsDeps(kv);
    const at = (iso: string) =>
      sweepCanary({ clock: new VirtualClock(iso), parsers: [dead], reports });

    assertEquals((await at("2026-08-20T00:00:00Z")).ran, true);
    assertEquals((await at("2026-08-20T00:15:00Z")).ran, false);
    assertEquals((await at("2026-08-20T18:00:00Z")).ran, false);
    assertEquals((await at("2026-08-21T00:00:00Z")).ran, true);

    // One report per day it was actually asked, not per tick.
    assertEquals((await listReports(kv)).length, 2);
  });
});

Deno.test("canary watch: the day is claimed before the providers are asked", async () => {
  await withKv(async (kv) => {
    const reports = reportsDeps(kv);
    const hangs = {
      name: "slow",
      supports: () => true,
      parse: () => Promise.reject(new Error("timeout")),
    };
    await sweepCanary({
      clock: new VirtualClock("2026-08-20T00:00:00Z"),
      parsers: [hangs],
      reports,
    });
    // Next tick must not ask again just because the last attempt went badly.
    const next = await sweepCanary({
      clock: new VirtualClock("2026-08-20T00:15:00Z"),
      parsers: [hangs],
      reports,
    });
    assertEquals(next.ran, false);
    assertEquals((await listReports(kv)).length, 1);
  });
});
