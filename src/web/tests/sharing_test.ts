import { assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { handleUserLookup, handleWebApi } from "../api.ts";
import { getOrCreateUserByEmail, setUid, updateUser, type WebUser } from "../users.ts";
import { listReservations } from "../store.ts";
import { handleCalendarFeed } from "../calendar/ics.ts";
import { makeAuthIds } from "./users_test.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

const BASE = "/api/reservations";

/** Build a request for handleWebApi (identity comes via opts, not headers). */
function apiReq(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

/** Calls handleWebApi as a specific user acting on their own ledger. */
function asUser(
  kv: Deno.Kv,
  ids: ReturnType<typeof makeAuthIds>,
  user: WebUser,
  method: string,
  path: string,
  body?: unknown,
  ledger = user.ledgerId,
) {
  return handleWebApi(kv, apiReq(method, path, body), ids, { user, ledger });
}

async function createConfirmed(
  kv: Deno.Kv,
  ids: ReturnType<typeof makeAuthIds>,
  owner: WebUser,
  service: string,
): Promise<string> {
  const res = await asUser(kv, ids, owner, "POST", BASE, {
    service,
    startsAt: "2026-08-01T19:00:00+09:00",
    policy: "unknown",
    confirmed: true,
  });
  return (await res.json()).reservation.id;
}

/** Owner + one invited member on one confirmed reservation. */
async function shared(
  kv: Deno.Kv,
  ids: ReturnType<typeof makeAuthIds>,
  role: "viewer" | "editor" = "viewer",
): Promise<{ owner: WebUser; member: WebUser; rid: string }> {
  const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
  const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
  const rid = await createConfirmed(kv, ids, owner, "宿");
  await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp", role });
  return { owner, member, rid };
}

Deno.test("lookup: exact email/uid hit (no email leaked); partial + logged-out miss", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "alice@example.com", ids);
    await updateUser(kv, u.id, (x) => ({ ...x, displayName: "アリス" }), ids);
    await setUid(kv, u.id, "aliceuser", ids);

    const byEmail = await (await handleUserLookup(
      kv,
      apiReq("GET", "/api/users/lookup?q=Alice@Example.com"),
      u,
    )).json();
    assertEquals(byEmail.found, true);
    assertEquals(byEmail.userId, u.id);
    assertEquals(byEmail.displayName, "アリス");
    assertEquals(byEmail.uid, "aliceuser");
    assertEquals("email" in byEmail, false); // never leaks the address

    const byUid = await (await handleUserLookup(
      kv,
      apiReq("GET", "/api/users/lookup?q=aliceuser"),
      u,
    )).json();
    assertEquals(byUid.found, true);
    assertEquals(byUid.userId, u.id);

    // Partial / prefix never matches (exact only).
    const partial = await (await handleUserLookup(
      kv,
      apiReq("GET", "/api/users/lookup?q=alice"),
      u,
    )).json();
    assertEquals(partial.found, false);

    // Logged out -> 401.
    const anon = await handleUserLookup(kv, apiReq("GET", "/api/users/lookup?q=aliceuser"), null);
    assertEquals(anon.status, 401);
  });
});

Deno.test("invite: owner adds a member; member sees the shared reservation and its roster", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "owner@x.jp", ids);
    await updateUser(kv, owner.id, (x) => ({ ...x, displayName: "オーナー太郎" }), ids);
    const member = await getOrCreateUserByEmail(kv, "member@x.jp", ids);

    const rid = await createConfirmed(kv, ids, owner, "湖畔の宿");

    const add = await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, {
      q: "member@x.jp",
    });
    assertEquals(add.status, 200);

    // Owner roster shows the one member.
    const roster = await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`)).json();
    assertEquals(roster.members.length, 1);
    assertEquals(roster.members[0].userId, member.id);

    // Owner's own list carries NO shared field.
    const ownerList = await (await asUser(kv, ids, owner, "GET", BASE)).json();
    assertEquals(ownerList.reservations.length, 1);
    assertEquals("shared" in ownerList.reservations[0], false);

    // Member's list merges the shared reservation with the owner display name.
    const memberList = await (await asUser(kv, ids, member, "GET", BASE)).json();
    assertEquals(memberList.reservations.length, 1);
    assertEquals(memberList.reservations[0].id, rid);
    assertEquals(memberList.reservations[0].shared.ownerDisplayName, "オーナー太郎");

    // Member may view the roster too.
    const memberRoster = await (await asUser(kv, ids, member, "GET", `${BASE}/${rid}/members`))
      .json();
    assertEquals(memberRoster.members.length, 1);
  });
});

Deno.test("invite: self / duplicate are no-op successes; unknown q -> 404 user_not_found", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "鮨");

    // Self-invite: succeeds but adds nobody.
    assertEquals(
      (await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "o@x.jp" }))
        .status,
      200,
    );
    // Duplicate: idempotent success.
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });
    const roster = await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`)).json();
    assertEquals(roster.members.length, 1);
    assertEquals(roster.members[0].userId, member.id);

    // Unknown user -> 404 user_not_found.
    const miss = await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, {
      q: "ghost@x.jp",
    });
    assertEquals(miss.status, 404);
    assertEquals((await miss.json()).error, "user_not_found");
  });
});

Deno.test("invite is owner-only: the demo ledger cannot share (403)", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "宿");
    // Acting on the ::demo namespace: sharing is disabled -> 403.
    const res = await asUser(
      kv,
      ids,
      owner,
      "POST",
      `${BASE}/${rid}/members`,
      { q: "m@x.jp" },
      `${owner.ledgerId}::demo`,
    );
    assertEquals(res.status, 403);
  });
});

Deno.test("viewer cannot edit / confirm / cancel / delete a shared reservation (403)", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { owner, member, rid } = await shared(kv, ids, "viewer");

    for (
      const [method, path] of [
        ["PATCH", `${BASE}/${rid}`],
        ["POST", `${BASE}/${rid}/confirm`],
        ["POST", `${BASE}/${rid}/cancel`],
        ["DELETE", `${BASE}/${rid}`],
      ] as const
    ) {
      const body = method === "PATCH" ? { service: "改ざん" } : undefined;
      const res = await asUser(kv, ids, member, method, path, body);
      assertEquals(res.status, 403, `${method} ${path} should be 403`);
    }
    // The owner's copy is untouched.
    const ownerList = await (await asUser(kv, ids, owner, "GET", BASE)).json();
    assertEquals(ownerList.reservations[0].service, "宿");
  });
});

Deno.test("editor patches the OWNER's record and fires the owner's calendar sync", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { owner, member, rid } = await shared(kv, ids, "editor");

    const synced: [string, string | null][] = [];
    const res = await handleWebApi(
      kv,
      apiReq("PATCH", `${BASE}/${rid}`, { service: "湖畔の宿（部屋変更）", amount: 24000 }),
      ids,
      {
        user: member,
        ledger: member.ledgerId,
        onMutate: (resvId, ledgerOwner) => synced.push([resvId, ledgerOwner?.id ?? null]),
      },
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).reservation.service, "湖畔の宿（部屋変更）");

    // The edit landed in the OWNER's ledger …
    const ownerList = await (await asUser(kv, ids, owner, "GET", BASE)).json();
    assertEquals(ownerList.reservations.length, 1);
    assertEquals(ownerList.reservations[0].service, "湖畔の宿（部屋変更）");
    assertEquals(ownerList.reservations[0].amount, 24000);
    // … and nothing was copied into the member's own ledger.
    assertEquals(await listReservations(kv, member.ledgerId), []);
    // The sync hook names the owner, so THEIR Google calendar is reconciled.
    assertEquals(synced, [[rid, owner.id]]);
  });
});

Deno.test("editor still cannot confirm / cancel / delete / invite / re-grade (403)", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { member, rid } = await shared(kv, ids, "editor");
    const other = await getOrCreateUserByEmail(kv, "o2@x.jp", ids);

    for (
      const [method, path, body] of [
        ["POST", `${BASE}/${rid}/confirm`, undefined],
        ["POST", `${BASE}/${rid}/cancel`, undefined],
        ["POST", `${BASE}/${rid}/restore`, undefined],
        ["DELETE", `${BASE}/${rid}`, undefined],
        ["POST", `${BASE}/${rid}/members`, { q: "o2@x.jp" }],
        ["PATCH", `${BASE}/${rid}/members/${other.id}`, { role: "editor" }],
      ] as const
    ) {
      const res = await asUser(kv, ids, member, method, path, body);
      assertEquals(res.status, 403, `${method} ${path} should be 403`);
    }
  });
});

Deno.test("role defaults to viewer, and a pre-role membership row reads as viewer", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "宿");

    // Invite without a role -> read-only.
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });
    const roster = await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`)).json();
    assertEquals(roster.members[0].role, "viewer");

    // A row written before roles existed (no `role` key) parses the same way
    // and stays read-only.
    const legacy = { addedAt: "2026-07-25T00:00:00.000Z" };
    await kv.set(["resv_members", owner.id, rid, member.id], legacy);
    await kv.set(["shared_in", member.id, owner.id, rid], legacy);
    const legacyRoster = await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`))
      .json();
    assertEquals(legacyRoster.members[0].role, "viewer");
    const memberList = await (await asUser(kv, ids, member, "GET", BASE)).json();
    assertEquals(memberList.reservations[0].shared.role, "viewer");
    const patch = await asUser(kv, ids, member, "PATCH", `${BASE}/${rid}`, { service: "改ざん" });
    assertEquals(patch.status, 403);
  });
});

Deno.test("role change: owner promotes and demotes; stranger 404; non-owner cannot", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { owner, member, rid } = await shared(kv, ids, "viewer");
    const stranger = await getOrCreateUserByEmail(kv, "s@x.jp", ids);

    const promoted = await asUser(kv, ids, owner, "PATCH", `${BASE}/${rid}/members/${member.id}`, {
      role: "editor",
    });
    assertEquals(promoted.status, 200);
    assertEquals((await promoted.json()).member.role, "editor");
    assertEquals(
      (await asUser(kv, ids, member, "PATCH", `${BASE}/${rid}`, { service: "編集" })).status,
      200,
    );

    const demoted = await asUser(kv, ids, owner, "PATCH", `${BASE}/${rid}/members/${member.id}`, {
      role: "viewer",
    });
    assertEquals(demoted.status, 200);
    assertEquals((await demoted.json()).member.role, "viewer");
    assertEquals(
      (await asUser(kv, ids, member, "PATCH", `${BASE}/${rid}`, { service: "再編集" })).status,
      403,
    );

    // A userId that is not on this roster -> 404 (nothing to re-grade).
    const ghost = await asUser(kv, ids, owner, "PATCH", `${BASE}/${rid}/members/${stranger.id}`, {
      role: "editor",
    });
    assertEquals(ghost.status, 404);

    // A stranger may not re-grade anyone, and learns nothing about the record.
    const byStranger = await asUser(
      kv,
      ids,
      stranger,
      "PATCH",
      `${BASE}/${rid}/members/${member.id}`,
      { role: "editor" },
    );
    assertEquals(byStranger.status, 404);
    assertEquals(
      (await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`)).json())
        .members[0].role,
      "viewer",
    );
  });
});

Deno.test("an unknown role string is rejected (400) on invite and on re-grade", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "宿");

    const badInvite = await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, {
      q: "m@x.jp",
      role: "admin",
    });
    assertEquals(badInvite.status, 400);
    // Nothing was shared by the rejected call.
    const roster = await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`)).json();
    assertEquals(roster.members.length, 0);

    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });
    const badRole = await asUser(kv, ids, owner, "PATCH", `${BASE}/${rid}/members/${member.id}`, {
      role: "owner",
    });
    assertEquals(badRole.status, 400);
  });
});

Deno.test("updated_by names the acting user on an editor's edit and on the owner's", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { owner, member, rid } = await shared(kv, ids, "editor");

    await asUser(kv, ids, member, "PATCH", `${BASE}/${rid}`, { service: "参加者が直した" });
    const afterMember = await (await asUser(kv, ids, owner, "GET", BASE)).json();
    assertEquals(afterMember.reservations[0].updated_by, member.id);

    await asUser(kv, ids, owner, "PATCH", `${BASE}/${rid}`, { service: "オーナーが直した" });
    const afterOwner = await (await asUser(kv, ids, owner, "GET", BASE)).json();
    assertEquals(afterOwner.reservations[0].updated_by, owner.id);
  });
});

Deno.test("member-facing responses never carry the owner's e-mail", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { owner, member, rid } = await shared(kv, ids, "viewer");

    // No display name and no uid: a neutral label, never the address.
    const listText = await (await asUser(kv, ids, member, "GET", BASE)).text();
    assertFalse(listText.includes(owner.email), "the owner's e-mail must not reach a member");
    assertEquals(JSON.parse(listText).reservations[0].shared.ownerDisplayName, "共有ユーザー");

    // With a uid it becomes @uid (still not the address).
    await setUid(kv, owner.id, "ownerhandle", ids);
    const withUid = await (await asUser(kv, ids, member, "GET", BASE)).text();
    assertFalse(withUid.includes(owner.email));
    assertEquals(JSON.parse(withUid).reservations[0].shared.ownerDisplayName, "@ownerhandle");

    // The roster a member may read carries no address either.
    const roster = await (await asUser(kv, ids, member, "GET", `${BASE}/${rid}/members`)).text();
    assertFalse(roster.includes(owner.email));
    assertFalse(roster.includes(member.email));
    assertEquals(JSON.parse(roster).members[0].label, "共有ユーザー");
  });
});

Deno.test("leave: member removes themselves; owner may also remove a member", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const other = await getOrCreateUserByEmail(kv, "o2@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "宿");
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "o2@x.jp" });

    // Member leaves via /members/me.
    const left = await asUser(kv, ids, member, "DELETE", `${BASE}/${rid}/members/me`);
    assertEquals(left.status, 200);
    assertEquals(
      (await (await asUser(kv, ids, member, "GET", BASE)).json()).reservations.length,
      0,
    );

    // Owner removes the remaining member by userId.
    const removed = await asUser(kv, ids, owner, "DELETE", `${BASE}/${rid}/members/${other.id}`);
    assertEquals(removed.status, 200);
    const roster = await (await asUser(kv, ids, owner, "GET", `${BASE}/${rid}/members`)).json();
    assertEquals(roster.members.length, 0);
  });
});

Deno.test("owner deleting the reservation sweeps its shares", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "宿");
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });

    const del = await asUser(kv, ids, owner, "DELETE", `${BASE}/${rid}`);
    assertEquals(del.status, 200);

    // The member no longer sees it, and the reverse-index ref is gone (404).
    assertEquals(
      (await (await asUser(kv, ids, member, "GET", BASE)).json()).reservations.length,
      0,
    );
    const roster = await asUser(kv, ids, member, "GET", `${BASE}/${rid}/members`);
    assertEquals(roster.status, 404);
  });
});

Deno.test("ICS feed: a member's subscription includes shared confirmed reservations", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "共有レストラン");
    await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "m@x.jp" });

    const feed = await handleCalendarFeed(
      kv,
      new Request(`https://app.test/calendar/${member.icsSecret}.ics`),
    );
    assertEquals(feed.status, 200);
    assertStringIncludes(await feed.text(), "共有レストラン");
  });
});

Deno.test("退会 integration: share mirrors are cleaned on both sides", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const { addMember, listMembers, listSharedIn } = await import("../sharing.ts");
    const { deleteAccount } = await import("../users.ts");
    const owner = await getOrCreateUserByEmail(kv, "owner@example.com", ids);
    const member = await getOrCreateUserByEmail(kv, "member@example.com", ids);
    await addMember(kv, owner.id, "R1", member.id, ids);

    // member 退会 -> owner's roster no longer lists them
    await deleteAccount(kv, member.id, ids);
    assertEquals(await listMembers(kv, owner.id, "R1"), []);

    // owner 退会 -> a member's shared_in no longer references the owner
    const owner2 = await getOrCreateUserByEmail(kv, "owner2@example.com", ids);
    const member2 = await getOrCreateUserByEmail(kv, "member2@example.com", ids);
    await addMember(kv, owner2.id, "R2", member2.id, ids);
    await deleteAccount(kv, owner2.id, ids);
    assertEquals(await listSharedIn(kv, member2.id), []);
  });
});
