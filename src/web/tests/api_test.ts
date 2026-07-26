import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { handleWebApi, isApiPath } from "../api.ts";
import type { WebIds } from "../store.ts";

function makeIds(): WebIds {
  let n = 0;
  return { newId: () => `R${++n}`, nowIso: () => "2026-07-16T00:00:00.000Z" };
}

const BASE = "/api/reservations";
function reqOf(method: string, path: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["x-plancel-token"] = token;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("isApiPath matches the reservation routes only", () => {
  assertEquals(isApiPath("/api/reservations"), true);
  assertEquals(isApiPath("/api/reservations/R1/confirm"), true);
  assertEquals(isApiPath("/"), false);
  assertEquals(isApiPath("/healthz"), false);
});

Deno.test("web api: missing token -> 400", async () => {
  await withKv(async (kv) => {
    const res = await handleWebApi(kv, reqOf("GET", "/api/reservations", null), makeIds());
    assertEquals(res.status, 400);
  });
});

Deno.test("web api: create then list is scoped to the token", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const create = await handleWebApi(
      kv,
      reqOf("POST", "/api/reservations", "tok-A", {
        service: "〇〇",
        startsAt: "2026-08-01T19:00:00+09:00",
        amount: 8000,
        policy: "free24",
      }),
      ids,
    );
    assertEquals(create.status, 201);

    const listA = await (await handleWebApi(kv, reqOf("GET", "/api/reservations", "tok-A"), ids))
      .json();
    assertEquals(listA.reservations.length, 1);
    assertEquals(listA.reservations[0].service, "〇〇");
    assertEquals(listA.reservations[0].status, "candidate");

    // Different token sees nothing (per-user isolation).
    const listB = await (await handleWebApi(kv, reqOf("GET", "/api/reservations", "tok-B"), ids))
      .json();
    assertEquals(listB.reservations.length, 0);
  });
});

Deno.test("web api: confirm settles siblings in the same plan -> to_cancel", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const mk = (service: string) =>
      handleWebApi(
        kv,
        reqOf("POST", "/api/reservations", "t", {
          plan: "8月の宿",
          service,
          startsAt: "2026-08-20T15:00:00+09:00",
          policy: "unknown",
        }),
        ids,
      );
    const a = (await (await mk("宿A")).json()).reservation;
    await mk("宿B");

    const confirmed =
      (await (await handleWebApi(kv, reqOf("POST", `${BASE}/${a.id}/confirm`, "t"), ids)).json())
        .reservation;
    assertEquals(confirmed.status, "confirmed");

    const list =
      (await (await handleWebApi(kv, reqOf("GET", "/api/reservations", "t"), ids)).json())
        .reservations;
    const b = list.find((r: { service: string }) => r.service === "宿B");
    assertEquals(b.status, "to_cancel");
  });
});

Deno.test("web api: confirm rejects cancelled and to_cancel transitions", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const mk = async (service: string) =>
      (await (await handleWebApi(
        kv,
        reqOf("POST", BASE, "t", {
          plan: "排他的な候補",
          service,
          startsAt: "2026-08-20T15:00:00+09:00",
          policy: "unknown",
        }),
        ids,
      )).json()).reservation;
    const a = await mk("宿A");
    const b = await mk("宿B");

    assertEquals(
      (await handleWebApi(kv, reqOf("POST", `${BASE}/${a.id}/confirm`, "t"), ids)).status,
      200,
    );
    const toCancel = await handleWebApi(
      kv,
      reqOf("POST", `${BASE}/${b.id}/confirm`, "t"),
      ids,
    );
    assertEquals(toCancel.status, 409);
    assertEquals((await toCancel.json()).error, "invalid_transition");

    await handleWebApi(kv, reqOf("POST", `${BASE}/${a.id}/cancel`, "t"), ids);
    const cancelled = await handleWebApi(
      kv,
      reqOf("POST", `${BASE}/${a.id}/confirm`, "t"),
      ids,
    );
    assertEquals(cancelled.status, 409);
    assertEquals((await cancelled.json()).error, "invalid_transition");
  });
});

Deno.test("web api: concurrent confirms leave exactly one plan winner", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const mk = async (service: string) =>
      (await (await handleWebApi(
        kv,
        reqOf("POST", BASE, "t", {
          plan: "同時確定プラン",
          service,
          startsAt: "2026-08-20T15:00:00+09:00",
          policy: "unknown",
        }),
        ids,
      )).json()).reservation;
    const a = await mk("宿A");
    const b = await mk("宿B");

    const results = await Promise.all([
      handleWebApi(kv, reqOf("POST", `${BASE}/${a.id}/confirm`, "t"), ids),
      handleWebApi(kv, reqOf("POST", `${BASE}/${b.id}/confirm`, "t"), ids),
    ]);
    assertEquals(results.map((r) => r.status).sort(), [200, 409]);

    const list = (await (await handleWebApi(kv, reqOf("GET", BASE, "t"), ids)).json()).reservations;
    assertEquals(list.filter((r: { status: string }) => r.status === "confirmed").length, 1);
    assertEquals(list.filter((r: { status: string }) => r.status === "to_cancel").length, 1);
  });
});

Deno.test("web api: concurrent create-with-confirmed also leaves one winner", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const createConfirmed = (service: string) =>
      handleWebApi(
        kv,
        reqOf("POST", BASE, "t", {
          plan: "作成時確定プラン",
          service,
          startsAt: "2026-08-20T15:00:00+09:00",
          policy: "unknown",
          confirmed: true,
        }),
        ids,
      );

    const results = await Promise.all([createConfirmed("宿A"), createConfirmed("宿B")]);
    assertEquals(results.map((r) => r.status).sort(), [201, 409]);

    const list = (await (await handleWebApi(kv, reqOf("GET", BASE, "t"), ids)).json()).reservations;
    assertEquals(list.length, 1);
    assertEquals(list[0].status, "confirmed");
  });
});

Deno.test("web api: stale plan guard does not block a restored candidate", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const mk = async (service: string) =>
      (await (await handleWebApi(
        kv,
        reqOf("POST", BASE, "t", {
          plan: "再選択プラン",
          service,
          startsAt: "2026-08-20T15:00:00+09:00",
          policy: "unknown",
        }),
        ids,
      )).json()).reservation;
    const a = await mk("宿A");
    const b = await mk("宿B");

    await handleWebApi(kv, reqOf("POST", `${BASE}/${a.id}/confirm`, "t"), ids);
    await handleWebApi(kv, reqOf("POST", `${BASE}/${a.id}/cancel`, "t"), ids);
    await handleWebApi(kv, reqOf("POST", `${BASE}/${b.id}/restore`, "t"), ids);
    assertEquals(
      (await handleWebApi(kv, reqOf("POST", `${BASE}/${b.id}/confirm`, "t"), ids)).status,
      200,
    );

    const list = (await (await handleWebApi(kv, reqOf("GET", BASE, "t"), ids)).json()).reservations;
    assertEquals(list.find((r: { id: string }) => r.id === a.id).status, "cancelled");
    assertEquals(list.find((r: { id: string }) => r.id === b.id).status, "confirmed");
  });
});

Deno.test("web api: patch edits fields; delete removes", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const r = (await (await handleWebApi(
      kv,
      reqOf("POST", "/api/reservations", "t", {
        service: "旧名",
        startsAt: "2026-09-01T12:00:00+09:00",
        policy: "unknown",
      }),
      ids,
    )).json()).reservation;

    const edited = (await (await handleWebApi(
      kv,
      reqOf("PATCH", `${BASE}/${r.id}`, "t", { service: "新名", amount: 12000 }),
      ids,
    )).json()).reservation;
    assertEquals(edited.service, "新名");
    assertEquals(edited.amount, 12000);

    const del = await handleWebApi(kv, reqOf("DELETE", `${BASE}/${r.id}`, "t"), ids);
    assertEquals(del.status, 200);
    const list =
      (await (await handleWebApi(kv, reqOf("GET", "/api/reservations", "t"), ids)).json())
        .reservations;
    assertEquals(list.length, 0);
  });
});

Deno.test("web api: location is optional, stored, and editable", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const created = (await (await handleWebApi(
      kv,
      reqOf("POST", "/api/reservations", "t", {
        service: "宿",
        startsAt: "2026-09-01T15:00:00+09:00",
        policy: "unknown",
      }),
      ids,
    )).json()).reservation;
    assertEquals(created.location, null); // omitted -> null, not required

    const edited = (await (await handleWebApi(
      kv,
      reqOf("PATCH", `${BASE}/${created.id}`, "t", { location: "諏訪湖畔" }),
      ids,
    )).json()).reservation;
    assertEquals(edited.location, "諏訪湖畔");
  });
});

Deno.test("web api: confirmed reservation cannot move to another plan", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const created = (await (await handleWebApi(
      kv,
      reqOf("POST", BASE, "t", {
        plan: "元のプラン",
        service: "確定済みの宿",
        startsAt: "2026-09-01T15:00:00+09:00",
        policy: "unknown",
        confirmed: true,
      }),
      ids,
    )).json()).reservation;

    const moved = await handleWebApi(
      kv,
      reqOf("PATCH", `${BASE}/${created.id}`, "t", { plan: "別のプラン" }),
      ids,
    );
    assertEquals(moved.status, 409);
    assertEquals((await moved.json()).error, "invalid_transition");

    const unchanged = (await (await handleWebApi(
      kv,
      reqOf("GET", BASE, "t"),
      ids,
    )).json()).reservations[0];
    assertEquals(unchanged.plan, "元のプラン");
  });
});

Deno.test("web api: cancelled reservations can be restored to candidate", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const r = (await (await handleWebApi(
      kv,
      reqOf("POST", "/api/reservations", "t", {
        service: "宿",
        startsAt: "2026-09-01T15:00:00+09:00",
        policy: "unknown",
        confirmed: true,
      }),
      ids,
    )).json()).reservation;

    await handleWebApi(kv, reqOf("POST", `${BASE}/${r.id}/cancel`, "t"), ids);
    const restored = (await (await handleWebApi(
      kv,
      reqOf("POST", `${BASE}/${r.id}/restore`, "t"),
      ids,
    )).json()).reservation;
    assertEquals(restored.status, "candidate");

    // restore on a non-cancelled reservation is a harmless no-op
    const again = (await (await handleWebApi(
      kv,
      reqOf("POST", `${BASE}/${r.id}/restore`, "t"),
      ids,
    )).json()).reservation;
    assertEquals(again.status, "candidate");
  });
});

Deno.test("web api: patch/confirm/delete on unknown id -> 404", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    assertEquals(
      (await handleWebApi(kv, reqOf("POST", `${BASE}/nope/confirm`, "t"), ids)).status,
      404,
    );
    assertEquals(
      (await handleWebApi(kv, reqOf("PATCH", `${BASE}/nope`, "t", { service: "x" }), ids)).status,
      404,
    );
    assertEquals((await handleWebApi(kv, reqOf("DELETE", `${BASE}/nope`, "t"), ids)).status, 404);
  });
});
