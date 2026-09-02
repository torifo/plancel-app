import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import {
  handleAdminReportsApi,
  handleReportsApi,
  isAdminReportsPath,
  isReportsPath,
  listReports,
  recordSystemReport,
  REPORT_DAILY_CAP,
  type ReportsDeps,
} from "../reports.ts";
import { getOrCreateUserByEmail, type WebUser } from "../users.ts";
import { makeAuthIds } from "./users_test.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

function makeDeps(kv: Deno.Kv, lines: string[] = []): ReportsDeps {
  let n = 0;
  return {
    kv,
    ids: {
      // Zero-padded so KV's byte order is the report order.
      ulid: () => `REP${String(++n).padStart(23, "0")}`,
      nowIso: () => "2026-08-20T06:00:00.000Z",
    },
    adminEmails: new Set(["dev@a.jp"]),
    logWrite: (line) => lines.push(line),
  };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const adminGet = (query = "") =>
  new Request(`http://localhost/api/admin/reports${query}`, { method: "GET" });

const user = (kv: Deno.Kv, email: string): Promise<WebUser> =>
  getOrCreateUserByEmail(kv, email, makeAuthIds());

Deno.test("reports: paths", () => {
  assertEquals(isReportsPath("/api/reports"), true);
  assertEquals(isReportsPath("/api/reports/x"), false);
  assertEquals(isAdminReportsPath("/api/admin/reports"), true);
  assertEquals(isAdminReportsPath("/api/reports"), false);
});

Deno.test("reports: an error report is stored with note and sample masked again", async () => {
  await withKv(async (kv) => {
    const lines: string[] = [];
    const deps = makeDeps(kv, lines);
    const u = await user(kv, "mom@b.jp");

    const res = await handleReportsApi(
      post({
        kind: "error",
        action: "読み取りに進めませんでした。",
        code: "unavailable",
        path: "/api/parse",
        build: "e1t9q8x8tgja",
        note: "予約を貼ったら出た。連絡先は 090-1234-5678",
        sample: "【ご予約確認】鮨さいとう 8/15 19:00 お電話 03-1234-5678 mail@example.com",
      }),
      deps,
      { user: u, ledger: u.ledgerId },
    );
    assertEquals(res.status, 201);
    const { id } = await res.json() as { id: string };

    const [stored] = await listReports(kv);
    assertEquals(stored?.id, id);
    assertEquals(stored?.kind, "error");
    assertEquals(stored?.userId, u.id);
    assertEquals(stored?.code, "unavailable");
    assertEquals(stored?.build, "e1t9q8x8tgja");
    // The browser is not trusted to have masked anything.
    assertEquals(stored?.note?.includes("090-1234-5678"), false);
    assertEquals(stored?.sample?.includes("03-1234-5678"), false);
    assertEquals(stored?.sample?.includes("mail@example.com"), false);
    assertStringIncludes(stored?.sample ?? "", "鮨さいとう");

    // The log says where, never what was typed.
    const record = JSON.parse(lines[0]!) as { msg: string; code: string; note?: unknown };
    assertEquals(record.msg, "report received");
    assertEquals(record.code, "unavailable");
    assertEquals(record.note, undefined);
  });
});

Deno.test("reports: a note typed afterwards refers to the earlier report", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv);
    const u = await user(kv, "mom@b.jp");
    const who = { user: u, ledger: u.ledgerId };
    const first = await handleReportsApi(post({ kind: "error", code: "unavailable" }), deps, who);
    const { id } = await first.json() as { id: string };
    const note = await handleReportsApi(
      post({ kind: "error", ref: id, note: "貼り付けたら出た" }),
      deps,
      who,
    );
    assertEquals(note.status, 201);
    const [latest, original] = await listReports(kv);
    assertEquals(latest?.ref, id);
    assertEquals(latest?.note, "貼り付けたら出た");
    assertEquals(original?.ref, null);
  });
});

Deno.test("reports: a browser cannot file a system report", async () => {
  await withKv(async (kv) => {
    const u = await user(kv, "mom@b.jp");
    const res = await handleReportsApi(
      post({ kind: "system", code: "x" }),
      makeDeps(kv),
      { user: u, ledger: u.ledgerId },
    );
    assertEquals(res.status, 400);
    assertEquals(await listReports(kv), []);
  });
});

Deno.test("reports: a wish from the help page is kind request", async () => {
  await withKv(async (kv) => {
    const u = await user(kv, "mom@b.jp");
    const res = await handleReportsApi(
      post({ kind: "request", view: "help", note: "終了した予約も一覧に残してほしい" }),
      makeDeps(kv),
      { user: u, ledger: u.ledgerId },
    );
    assertEquals(res.status, 201);
    const [stored] = await listReports(kv);
    assertEquals(stored?.kind, "request");
    assertEquals(stored?.note, "終了した予約も一覧に残してほしい");
  });
});

Deno.test("reports: bad bodies and wrong methods are refused", async () => {
  await withKv(async (kv) => {
    const u = await user(kv, "mom@b.jp");
    const who = { user: u, ledger: u.ledgerId };
    const deps = makeDeps(kv);
    assertEquals(
      (await handleReportsApi(new Request("http://localhost/api/reports"), deps, who)).status,
      405,
    );
    assertEquals(
      (await handleReportsApi(
        new Request("http://localhost/api/reports", { method: "POST", body: "{" }),
        deps,
        who,
      )).status,
      400,
    );
    assertEquals((await handleReportsApi(post({ kind: "oops" }), deps, who)).status, 400);
    assertEquals((await handleReportsApi(post({}), deps, who)).status, 400);
  });
});

Deno.test("reports: the daily cap stops a browser stuck in a loop", async () => {
  await withKv(async (kv) => {
    const lines: string[] = [];
    const deps = makeDeps(kv, lines);
    const u = await user(kv, "mom@b.jp");
    const who = { user: u, ledger: u.ledgerId };
    for (let i = 0; i < REPORT_DAILY_CAP; i += 1) {
      assertEquals(
        (await handleReportsApi(post({ kind: "error", code: "x" }), deps, who)).status,
        201,
      );
    }
    const over = await handleReportsApi(post({ kind: "error", code: "x" }), deps, who);
    assertEquals(over.status, 429);
    assertEquals((await over.json() as { error: string }).error, "rate limited");
    assertEquals((await listReports(kv)).length, REPORT_DAILY_CAP);
    assertEquals(
      lines.some((l) => (JSON.parse(l) as { msg: string }).msg === "report cap reached; dropped"),
      true,
    );
  });
});

Deno.test("reports: a caller without a user or ledger is not accepted", async () => {
  await withKv(async (kv) => {
    const res = await handleReportsApi(post({ kind: "error" }), makeDeps(kv), {
      user: null,
      ledger: null,
    });
    assertEquals(res.status, 401);
  });
});

Deno.test("reports: the app's own faults are kind system, with no person and no cap", async () => {
  await withKv(async (kv) => {
    const lines: string[] = [];
    const deps = makeDeps(kv, lines);
    const r = await recordSystemReport(deps, {
      code: "provider_unavailable",
      detail: "groq http 404: model_not_found",
      path: "canary",
    });
    assertEquals(r.kind, "system");
    assertEquals(r.userId, null);
    const [stored] = await listReports(kv);
    assertEquals(stored?.id, r.id);
    assertEquals(stored?.note, "groq http 404: model_not_found");
    const record = JSON.parse(lines[0]!) as { level: string; msg: string };
    assertEquals(record.level, "error");
    assertEquals(record.msg, "system fault recorded");
  });
});

Deno.test("reports: only an admin email may read the list, newest first", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv);
    const mom = await user(kv, "mom@b.jp");
    const dev = await user(kv, "Dev@A.jp"); // case must not matter
    const who = { user: mom, ledger: mom.ledgerId };
    await handleReportsApi(post({ kind: "error", code: "first" }), deps, who);
    await handleReportsApi(post({ kind: "request", note: "second" }), deps, who);
    await recordSystemReport(deps, { code: "third" });

    const denied = await handleAdminReportsApi(adminGet(), deps, who);
    assertEquals(denied.status, 403);
    const anon = await handleAdminReportsApi(adminGet(), deps, { user: null, ledger: "t" });
    assertEquals(anon.status, 403);

    const ok = await handleAdminReportsApi(adminGet(), deps, { user: dev, ledger: dev.ledgerId });
    assertEquals(ok.status, 200);
    const { reports } = await ok.json() as { reports: { code: string | null; kind: string }[] };
    assertEquals(reports.map((r) => r.kind), ["system", "request", "error"]);

    const only = await handleAdminReportsApi(adminGet("?kind=request"), deps, {
      user: dev,
      ledger: dev.ledgerId,
    });
    const filtered = await only.json() as { reports: { kind: string }[] };
    assertEquals(filtered.reports.map((r) => r.kind), ["request"]);

    const wrongMethod = await handleAdminReportsApi(
      new Request("http://localhost/api/admin/reports", { method: "POST" }),
      deps,
      { user: dev, ledger: dev.ledgerId },
    );
    assertEquals(wrongMethod.status, 405);
  });
});
