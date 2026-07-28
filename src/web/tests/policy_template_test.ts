import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { z } from "zod";
import {
  deleteTemplate,
  facilityKey,
  getTemplate,
  listTemplates,
  saveTemplate,
} from "../policy-template.ts";
import { handleWebApi } from "../api.ts";
import type { WebIds } from "../store.ts";
import { type AuthIds, getOrCreateUserByEmail, type WebUser } from "../users.ts";

const BASE = "/api/policy-templates";

/** WebIds plus the auth extras `getOrCreateUserByEmail` needs. */
function makeIds(nowIso = "2026-07-27T00:00:00.000Z"): AuthIds {
  let n = 0;
  let t = 0;
  return {
    newId: () => `ID${++n}`,
    nowIso: () => nowIso,
    nowMs: () => 1_000_000,
    randomToken: () => `tok${++t}`,
  };
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

function reqOf(method: string, path: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["x-plancel-token"] = token;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Path form the UI/MCP use: the facility name is percent-encoded. */
const pathOf = (facility: string) => `${BASE}/${encodeURIComponent(facility)}`;

function asUser(
  kv: Deno.Kv,
  ids: WebIds,
  user: WebUser,
  method: string,
  path: string,
  body?: unknown,
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return handleWebApi(kv, req, ids, { user, ledger: user.ledgerId });
}

// ---- normalization ----

Deno.test("policy templates: the facility key folds width, case, and whitespace", () => {
  // Full-width ASCII, ideographic space, surrounding + repeated whitespace, case.
  assertEquals(facilityKey("　Ｌａｋｅｓｉｄｅ　Ｉｎｎ　"), "lakeside inn");
  assertEquals(facilityKey("  lakeside   INN "), "lakeside inn");
  assertEquals(facilityKey("湖畔の湯宿　蛍"), facilityKey("湖畔の湯宿 蛍"));
  // Half-width katakana folds to the composed form (NFKC).
  assertEquals(facilityKey("ﾎﾃﾙ翠嶺"), facilityKey("ホテル翠嶺"));
  // Distinct facilities keep distinct keys.
  assertEquals(facilityKey("宿A") === facilityKey("宿B"), false);
  assertEquals(facilityKey("湖畔の湯宿蛍") === facilityKey("湖畔の湯宿 蛍"), false);
});

Deno.test("policy templates: a save is found through any spelling of the name", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    await saveTemplate(kv, "t", "　Ｌａｋｅｓｉｄｅ　Ｉｎｎ　", "free24", ids);
    for (const q of ["lakeside inn", "LAKESIDE   Inn", "Ｌａｋｅｓｉｄｅ Ｉｎｎ"]) {
      assertEquals((await getTemplate(kv, "t", q))?.policy, "free24", q);
    }
    // The display name keeps the trimmed original, not the folded key.
    assertEquals(
      (await getTemplate(kv, "t", "lakeside inn"))?.facility,
      "Ｌａｋｅｓｉｄｅ　Ｉｎｎ",
    );

    await saveTemplate(kv, "t", "湖畔の湯宿　蛍", "staged", ids);
    assertEquals((await getTemplate(kv, "t", "湖畔の湯宿 蛍"))?.policy, "staged");
    // A different facility is untouched by that save.
    assertEquals(await getTemplate(kv, "t", "湖畔の湯宿蛍"), null);
  });
});

// ---- schema round-trip ----

Deno.test("policy templates: preset names and custom stage tables round-trip canonically", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const saved = await saveTemplate(kv, "t", "翠嶺館", {
      stages: [{ h: 0, pct: 100 }, { h: 120, pct: 0 }, { h: 72, pct: 30 }],
    }, ids);
    // Stored canonical (h descending), exactly like the ledger's policies.
    assertEquals(saved.policy, {
      stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }, { h: 0, pct: 100 }],
    });
    assertEquals(saved.updated_at, "2026-07-27T00:00:00.000Z");
    assertEquals((await getTemplate(kv, "t", "翠嶺館"))?.policy, saved.policy);

    // A table equal to a preset collapses to the preset NAME.
    const preset = await saveTemplate(kv, "t", "鮨処", {
      stages: [{ h: 24, pct: 0 }, { h: 0, pct: 100 }],
    }, ids);
    assertEquals(preset.policy, "free24");
  });
});

Deno.test('policy templates: "unknown" and malformed policies are refused', async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    // A template that states no rate would pre-fill 不明 and hide that the fee
    // table was never entered — worse than having no template.
    await assertRejects(() => saveTemplate(kv, "t", "宿", "unknown", ids), z.ZodError);
    // No 当日 (h=0) stage: the policy model refuses to guess the closing rate.
    await assertRejects(
      () => saveTemplate(kv, "t", "宿", { stages: [{ h: 120, pct: 0 }] }, ids),
      z.ZodError,
    );
    await assertRejects(() => saveTemplate(kv, "t", "  ", "free24", ids), z.ZodError);
    await assertRejects(() => saveTemplate(kv, "t", "宿".repeat(101), "free24", ids), z.ZodError);
    assertEquals(await listTemplates(kv, "t"), []);
  });
});

// ---- overwrite / list / delete ----

Deno.test("policy templates: overwrite wins, list is sorted, delete is idempotent", async () => {
  await withKv(async (kv) => {
    await saveTemplate(kv, "t", "Zulu Ryokan", "free24", makeIds("2026-07-27T00:00:00.000Z"));
    await saveTemplate(kv, "t", "Alpha Hotel", "none", makeIds());
    await saveTemplate(kv, "t", "Bravo Inn", "staged", makeIds());

    // Same facility, new spelling + new policy: one record, last write wins.
    const later = makeIds("2026-07-28T09:00:00.000Z");
    await saveTemplate(kv, "t", "zulu   ryokan", "staged", later);

    const list = await listTemplates(kv, "t");
    assertEquals(list.map((r) => r.facility), ["Alpha Hotel", "Bravo Inn", "zulu   ryokan"]);
    const zulu = list[2];
    assertEquals(zulu?.policy, "staged");
    assertEquals(zulu?.updated_at, "2026-07-28T09:00:00.000Z");

    await deleteTemplate(kv, "t", "ZULU RYOKAN");
    assertEquals(await getTemplate(kv, "t", "Zulu Ryokan"), null);
    // Deleting again (or something never saved) is still a success.
    await deleteTemplate(kv, "t", "Zulu Ryokan");
    await deleteTemplate(kv, "t", "存在しない宿");
    assertEquals((await listTemplates(kv, "t")).length, 2);
  });
});

// ---- HTTP ----

Deno.test("policy-templates API: put, list, lookup, delete", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const put = await handleWebApi(
      kv,
      reqOf("PUT", pathOf("湖畔の湯宿　蛍"), "t", { policy: "free24" }),
      ids,
    );
    assertEquals(put.status, 200);
    const stored = (await put.json()).template;
    assertEquals(stored.facility, "湖畔の湯宿　蛍");
    assertEquals(stored.policy, "free24");

    const list = await (await handleWebApi(kv, reqOf("GET", BASE, "t"), ids)).json();
    assertEquals(list.templates.length, 1);

    // Lookup: the form's pre-fill call — folded match hits, anything else misses.
    const hit = await (await handleWebApi(
      kv,
      reqOf("GET", `${BASE}/lookup?service=${encodeURIComponent("湖畔の湯宿 蛍")}`, "t"),
      ids,
    )).json();
    assertEquals(hit.template.policy, "free24");
    const miss = await (await handleWebApi(
      kv,
      reqOf("GET", `${BASE}/lookup?service=${encodeURIComponent("湖畔")}`, "t"),
      ids,
    )).json();
    assertEquals(miss.template, null);
    // No `service` at all is a miss, not an error.
    const empty = await (await handleWebApi(kv, reqOf("GET", `${BASE}/lookup`, "t"), ids)).json();
    assertEquals(empty.template, null);

    const del = await handleWebApi(kv, reqOf("DELETE", pathOf("湖畔の湯宿 蛍"), "t"), ids);
    assertEquals(del.status, 204);
    assertEquals(await del.text(), "");
    // Idempotent: deleting a missing template is still 204.
    assertEquals(
      (await handleWebApi(kv, reqOf("DELETE", pathOf("湖畔の湯宿 蛍"), "t"), ids)).status,
      204,
    );
    assertEquals(
      (await (await handleWebApi(kv, reqOf("GET", BASE, "t"), ids)).json()).templates.length,
      0,
    );
  });
});

Deno.test('policy-templates API: "unknown" / malformed / bad method are rejected', async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const unknown = await handleWebApi(
      kv,
      reqOf("PUT", pathOf("宿"), "t", { policy: "unknown" }),
      ids,
    );
    assertEquals(unknown.status, 400);
    assertEquals((await unknown.json()).error, "invalid");

    const noClosingStage = await handleWebApi(
      kv,
      reqOf("PUT", pathOf("宿"), "t", { policy: { stages: [{ h: 120, pct: 0 }] } }),
      ids,
    );
    assertEquals(noClosingStage.status, 400);

    assertEquals(
      (await handleWebApi(kv, reqOf("PUT", pathOf("宿"), "t", {}), ids)).status,
      400,
    );
    assertEquals(
      (await handleWebApi(kv, reqOf("PUT", `${BASE}/%20%20`, "t", { policy: "none" }), ids)).status,
      400,
    );
    assertEquals((await handleWebApi(kv, reqOf("POST", BASE, "t", {}), ids)).status, 405);
    // A facility has no sub-resources.
    assertEquals(
      (await handleWebApi(kv, reqOf("PUT", `${pathOf("宿")}/extra`, "t", { policy: "none" }), ids))
        .status,
      404,
    );
    // Missing ledger token is refused before anything is read.
    assertEquals((await handleWebApi(kv, reqOf("GET", BASE, null), ids)).status, 400);
    assertEquals(await listTemplates(kv, "t"), []);
  });
});

Deno.test("policy-templates API: templates are private to their ledger", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    await handleWebApi(kv, reqOf("PUT", pathOf("翠嶺館"), "tok-A", { policy: "staged" }), ids);

    // Another ledger neither lists nor looks up A's template.
    const listB = await (await handleWebApi(kv, reqOf("GET", BASE, "tok-B"), ids)).json();
    assertEquals(listB.templates.length, 0);
    const lookupB = await (await handleWebApi(
      kv,
      reqOf("GET", `${BASE}/lookup?service=${encodeURIComponent("翠嶺館")}`, "tok-B"),
      ids,
    )).json();
    assertEquals(lookupB.template, null);

    // B deleting the same facility name does not touch A's record.
    assertEquals(
      (await handleWebApi(kv, reqOf("DELETE", pathOf("翠嶺館"), "tok-B"), ids)).status,
      204,
    );
    assertEquals((await getTemplate(kv, "tok-A", "翠嶺館"))?.policy, "staged");
  });
});

Deno.test("policy-templates API: a shared-reservation member cannot read the owner's templates", async () => {
  await withKv(async (kv) => {
    const ids = makeIds();
    const owner = await getOrCreateUserByEmail(kv, "owner@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "member@x.jp", ids);

    // Owner has a template and shares a reservation at that facility.
    await asUser(kv, ids, owner, "PUT", pathOf("翠嶺館"), { policy: "staged" });
    const rid = (await (await handleWebApi(
      kv,
      new Request("http://localhost/api/reservations", {
        method: "POST",
        body: JSON.stringify({
          service: "翠嶺館",
          startsAt: "2026-08-20T15:00:00+09:00",
          policy: "staged",
          confirmed: true,
        }),
      }),
      ids,
      { user: owner, ledger: owner.ledgerId },
    )).json()).reservation.id;
    await handleWebApi(
      kv,
      new Request(`http://localhost/api/reservations/${rid}/members`, {
        method: "POST",
        body: JSON.stringify({ q: "member@x.jp" }),
      }),
      ids,
      { user: owner, ledger: owner.ledgerId },
    );

    // The member sees the shared reservation…
    const shared = await (await handleWebApi(
      kv,
      new Request("http://localhost/api/reservations"),
      ids,
      { user: member, ledger: member.ledgerId },
    )).json();
    assertEquals(shared.reservations.length, 1);

    // …but the owner's template library stays private.
    const list = await (await asUser(kv, ids, member, "GET", BASE)).json();
    assertEquals(list.templates.length, 0);
    const lookup = await (await asUser(
      kv,
      ids,
      member,
      "GET",
      `${BASE}/lookup?service=${encodeURIComponent("翠嶺館")}`,
    )).json();
    assertEquals(lookup.template, null);

    // The member's own save lands in their ledger only.
    await asUser(kv, ids, member, "PUT", pathOf("翠嶺館"), { policy: "none" });
    assertEquals((await getTemplate(kv, member.ledgerId, "翠嶺館"))?.policy, "none");
    assertEquals((await getTemplate(kv, owner.ledgerId, "翠嶺館"))?.policy, "staged");
  });
});

// ---- the rescue itself: one rule, applied wherever a reservation is created ----

Deno.test("policy templates: 規定が不明の登録は施設の既定規定を受け取る（API/MCP 経路）", async () => {
  await withKv(async (kv) => {
    // この規則は createReservation（src/web/store.ts）に1か所だけ置いてある。
    // 以前は取り込み経路ごとに書かれていて、LINE と MCP が引き忘れていた:
    // 同じ宿でも入れる場所によって規定が入ったり不明のままだったりした。
    const ids = makeIds();
    const owner = await getOrCreateUserByEmail(kv, "owner@example.com", ids);
    await saveTemplate(kv, owner.ledgerId, "翠嶺館", "staged", ids);

    // MCP の create_reservation はこの POST に落ちる（policy 既定値は "unknown"）。
    const created = await (await asUser(kv, ids, owner, "POST", "/api/reservations", {
      service: "翠嶺館",
      startsAt: "2026-08-22T15:00:00+09:00",
      policy: "unknown",
    })).json();
    assertEquals(created.reservation.policy, "staged");

    // 読み取れた規定は塗り替えない — その予約に固有の料率表のほうが強い。
    const stated = await (await asUser(kv, ids, owner, "POST", "/api/reservations", {
      service: "翠嶺館",
      startsAt: "2026-08-23T15:00:00+09:00",
      policy: "free24",
    })).json();
    assertEquals(stated.reservation.policy, "free24");

    // 既定を持たない施設は不明のまま（勝手に他所の規定を借りない）。
    const other = await (await asUser(kv, ids, owner, "POST", "/api/reservations", {
      service: "名も無き宿",
      startsAt: "2026-08-24T15:00:00+09:00",
      policy: "unknown",
    })).json();
    assertEquals(other.reservation.policy, "unknown");
  });
});
