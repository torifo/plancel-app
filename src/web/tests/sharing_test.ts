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

Deno.test("invite: self -> 400, duplicate is a no-op success, unknown q -> 404 user_not_found", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const owner = await getOrCreateUserByEmail(kv, "o@x.jp", ids);
    const member = await getOrCreateUserByEmail(kv, "m@x.jp", ids);
    const rid = await createConfirmed(kv, ids, owner, "鮨");

    // Self-invite used to be a silent success; a model then told the user the
    // share was done (issue #5). It is a mistake, so it is refused as one.
    const self = await asUser(kv, ids, owner, "POST", `${BASE}/${rid}/members`, { q: "o@x.jp" });
    assertEquals(self.status, 400);
    assertEquals((await self.json()).error, "cannot_share_with_self");
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

// ---- merging two entries of the same booking (owner 2026-11-12) ----

Deno.test("merge: two of my own entries become one, keeping what either knew", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const friend = await getOrCreateUserByEmail(kv, "f@x.jp", ids);
    const mk = async (body: Record<string, unknown>) =>
      (await (await asUser(kv, ids, me, "POST", BASE, body)).json()).reservation;
    const keep = await mk({
      service: "白菊",
      startsAt: "2026-12-19",
      notes: "夕朝食付き",
      booked: false,
    });
    const other = await mk({
      service: "ホテル白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
      endsAt: "2026-12-20",
      amount: 48000,
      policy: "free24",
      notes: "予約番号 TEST-1",
      bookedBy: "母",
      kind: "stay",
    });
    await asUser(kv, ids, me, "POST", `${BASE}/${other.id}/members`, { q: "f@x.jp" });

    const res = await asUser(kv, ids, me, "POST", `${BASE}/${keep.id}/merge`, { from: other.id });
    assertEquals(res.status, 200);
    const body = await res.json();
    const r = body.reservation;
    // Its own values stay; blanks are filled from the other.
    assertEquals(r.service, "白菊");
    assertEquals([r.amount, r.policy, r.bookedBy, r.kind], [48000, "free24", "母", "stay"]);
    assertEquals(r.endsAt, "2026-12-19T15:00:00.000Z");
    // A real time beats "not known yet"; booked if either was.
    assertEquals([r.startsAt, r.timeTentative, r.booked], [
      "2026-12-19T06:00:00.000Z",
      false,
      true,
    ]);
    assertEquals(r.notes, "夕朝食付き\n予約番号 TEST-1");
    assertEquals(body.removedId, other.id);
    assertEquals(body.filled.includes("amount") && body.filled.includes("policy"), true);

    const left = await listReservations(kv, me.ledgerId);
    assertEquals(left.map((x) => x.id), [keep.id]);
    // Whoever the removed one was shared with still sees the booking.
    const roster = await (await asUser(kv, ids, me, "GET", `${BASE}/${keep.id}/members`)).json();
    assertEquals(roster.members.map((m: { userId: string }) => m.userId), [friend.id]);

    // Merging something into itself, or something that is not mine, is refused.
    assertEquals(
      (await asUser(kv, ids, me, "POST", `${BASE}/${keep.id}/merge`, { from: keep.id })).status,
      400,
    );
    assertEquals(
      (await asUser(kv, ids, me, "POST", `${BASE}/${keep.id}/merge`, { from: "NOPE" })).status,
      404,
    );
  });
});

Deno.test("merge: my copy folds into the one shared with me — if I may edit it", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const hers = (await (await asUser(kv, ids, mom, "POST", BASE, {
      service: "白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
      confirmed: true,
    })).json()).reservation;
    const mine = (await (await asUser(kv, ids, me, "POST", BASE, {
      service: "白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
      amount: 48000,
      policy: "staged",
    })).json()).reservation;
    await asUser(kv, ids, mom, "POST", `${BASE}/${hers.id}/members`, { q: "me@x.jp" });

    // A viewer cannot change hers, so nothing of mine is removed either.
    const viewer = await asUser(kv, ids, me, "POST", `${BASE}/${hers.id}/merge`, { from: mine.id });
    assertEquals(viewer.status, 403);
    assertEquals((await listReservations(kv, me.ledgerId)).length, 1);

    await asUser(kv, ids, mom, "PATCH", `${BASE}/${hers.id}/members/${me.id}`, { role: "editor" });
    const ok = await asUser(kv, ids, me, "POST", `${BASE}/${hers.id}/merge`, { from: mine.id });
    assertEquals(ok.status, 200);
    const merged = (await ok.json()).reservation;
    assertEquals([merged.id, merged.amount, merged.policy, merged.status], [
      hers.id,
      48000,
      "staged",
      "confirmed",
    ]);
    // Mine is gone; hers lives in her ledger with what I knew.
    assertEquals((await listReservations(kv, me.ledgerId)).length, 0);
    assertEquals((await listReservations(kv, mom.ledgerId))[0]?.amount, 48000);
    // She cannot fold MY entry away from her side: the removed one must be the caller's own.
    const mine2 = (await (await asUser(kv, ids, me, "POST", BASE, {
      service: "白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
    })).json()).reservation;
    assertEquals(
      (await asUser(kv, ids, mom, "POST", `${BASE}/${hers.id}/merge`, { from: mine2.id })).status,
      404,
    );
  });
});

Deno.test("choose: of two of my own stays, one is confirmed and the other waits to be cancelled", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const mk = async (body: Record<string, unknown>) =>
      (await (await asUser(kv, ids, me, "POST", BASE, {
        startsAt: "2026-12-19T15:00:00+09:00",
        endsAt: "2026-12-20",
        ...body,
      })).json()).reservation;
    const a = await mk({ service: "おにやまホテル", confirmed: true });
    const b = await mk({ service: "ホテル白菊" });
    const idea = await mk({ service: "まだ取っていない宿", booked: false });

    const res = await asUser(kv, ids, me, "POST", `${BASE}/${b.id}/choose`, {
      over: [a.id, idea.id],
    });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.reservation.status, "confirmed");
    assertEquals(out.needsOwner, []);
    // The held one waits for the call to the inn; the idea is simply out.
    assertEquals(
      out.affected.map((x: { id: string; status: string }) => [x.id, x.status]),
      [[a.id, "to_cancel"], [idea.id, "cancelled"]],
    );
    const rows = await listReservations(kv, me.ledgerId);
    assertEquals(
      Object.fromEntries(rows.map((r) => [r.service, r.status])),
      {
        "おにやまホテル": "to_cancel",
        "ホテル白菊": "confirmed",
        "まだ取っていない宿": "cancelled",
      },
    );

    // Bad calls change nothing.
    assertEquals(
      (await asUser(kv, ids, me, "POST", `${BASE}/${b.id}/choose`, { over: [b.id] })).status,
      400,
    );
    assertEquals(
      (await asUser(kv, ids, me, "POST", `${BASE}/${b.id}/choose`, { over: ["NOPE"] })).status,
      404,
    );
    assertEquals(
      (await asUser(kv, ids, me, "POST", `${BASE}/${b.id}/choose`, { over: [] })).status,
      400,
    );
  });
});

Deno.test("choose: what is only shared with me stays its owner's to settle, and I am told whom to ask", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const stranger = await getOrCreateUserByEmail(kv, "other@x.jp", ids);
    const hers = (await (await asUser(kv, ids, mom, "POST", BASE, {
      service: "ホテル白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
      endsAt: "2026-12-20",
    })).json()).reservation;
    const mine = (await (await asUser(kv, ids, me, "POST", BASE, {
      service: "おにやまホテル",
      startsAt: "2026-12-19T15:30:00+09:00",
      endsAt: "2026-12-20",
      confirmed: true,
    })).json()).reservation;
    // Not shared yet: hers is not mine to name at all.
    assertEquals(
      (await asUser(kv, ids, me, "POST", `${BASE}/${mine.id}/choose`, { over: [hers.id] })).status,
      404,
    );
    await asUser(kv, ids, mom, "POST", `${BASE}/${hers.id}/members`, {
      q: "me@x.jp",
      role: "editor",
    });

    // Mine over hers: mine is already confirmed, hers is untouched even though I may edit it.
    const keepMine = await (await asUser(kv, ids, me, "POST", `${BASE}/${mine.id}/choose`, {
      over: [hers.id],
    })).json();
    assertEquals(keepMine.affected, []);
    assertEquals(
      keepMine.needsOwner.map((x: { id: string; need: string }) => [x.id, x.need]),
      [[hers.id, "cancel"]],
    );
    assertEquals((await listReservations(kv, mom.ledgerId))[0]?.status, "candidate");

    // Hers over mine: mine steps down here; confirming hers is asked of her.
    const keepHers = await (await asUser(kv, ids, me, "POST", `${BASE}/${hers.id}/choose`, {
      over: [mine.id],
    })).json();
    assertEquals(keepHers.reservation, undefined);
    assertEquals(
      keepHers.affected.map((x: { id: string; status: string }) => [x.id, x.status]),
      [[mine.id, "to_cancel"]],
    );
    assertEquals(
      keepHers.needsOwner.map((x: { id: string; need: string }) => [x.id, x.need]),
      [[hers.id, "confirm"]],
    );
    assertEquals((await listReservations(kv, mom.ledgerId))[0]?.status, "candidate");
    // Someone it is not shared with cannot name either.
    assertEquals(
      (await asUser(kv, ids, stranger, "POST", `${BASE}/${hers.id}/choose`, { over: [mine.id] }))
        .status,
      404,
    );
  });
});

Deno.test("rank: the order of preference is set by the owner or an editor, and everyone sees it", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const hers = (await (await asUser(kv, ids, mom, "POST", BASE, {
      service: "ホテル白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
    })).json()).reservation;
    assertEquals(hers.rank, null);
    await asUser(kv, ids, mom, "POST", `${BASE}/${hers.id}/members`, { q: "me@x.jp" });
    // A viewer cannot reorder what is not theirs.
    assertEquals(
      (await asUser(kv, ids, me, "PATCH", `${BASE}/${hers.id}`, { rank: 2 })).status,
      403,
    );
    await asUser(kv, ids, mom, "PATCH", `${BASE}/${hers.id}/members/${me.id}`, { role: "editor" });
    assertEquals(
      (await asUser(kv, ids, me, "PATCH", `${BASE}/${hers.id}`, { rank: 2 })).status,
      200,
    );
    // Stored on the owner's record, so she sees the order the family set.
    assertEquals((await listReservations(kv, mom.ledgerId))[0]?.rank, 2);
    assertEquals(
      (await asUser(kv, ids, mom, "PATCH", `${BASE}/${hers.id}`, { rank: 0 })).status,
      400,
    );
    await asUser(kv, ids, mom, "PATCH", `${BASE}/${hers.id}`, { rank: null });
    assertEquals((await listReservations(kv, mom.ledgerId))[0]?.rank, null);
  });
});

Deno.test("suggest: a member proposes, the owner accepts or declines, and settling stays hers", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const stranger = await getOrCreateUserByEmail(kv, "other@x.jp", ids);
    const mk = async (service: string) =>
      (await (await asUser(kv, ids, mom, "POST", BASE, {
        service,
        startsAt: "2026-12-19T15:00:00+09:00",
      })).json()).reservation;
    const hers = await mk("ホテル白菊");
    const other = await mk("別の宿");
    for (const r of [hers, other]) {
      await asUser(kv, ids, mom, "POST", `${BASE}/${r.id}/members`, { q: "me@x.jp" });
    }
    const S = (r: { id: string }) => `${BASE}/${r.id}/suggest`;

    // Not shared with the stranger; the owner herself has nothing to propose.
    assertEquals(
      (await asUser(kv, ids, stranger, "POST", S(hers), { action: "cancel" })).status,
      404,
    );
    assertEquals((await asUser(kv, ids, mom, "POST", S(hers), { action: "cancel" })).status, 400);
    assertEquals((await asUser(kv, ids, me, "POST", S(hers), { action: "maybe" })).status, 400);

    // Even a viewer may propose; nothing is settled by it.
    const res = await asUser(kv, ids, me, "POST", S(hers), { action: "cancel" });
    assertEquals(res.status, 200);
    let row = (await listReservations(kv, mom.ledgerId)).find((r) => r.id === hers.id)!;
    assertEquals([row.status, row.suggestion?.action, row.suggestion?.notifiedAt], [
      "candidate",
      "cancel",
      null,
    ]);
    // The member's list shows it on the shared row too.
    const mine = (await (await asUser(kv, ids, me, "GET", BASE)).json()).reservations;
    assertEquals(mine.find((r: { id: string }) => r.id === hers.id).suggestion.action, "cancel");

    // Only the owner accepts; accepting a cancel turns it to_cancel and clears the proposal.
    assertEquals((await asUser(kv, ids, me, "POST", `${S(hers)}/accept`)).status, 403);
    assertEquals((await asUser(kv, ids, mom, "POST", `${S(hers)}/accept`)).status, 200);
    row = (await listReservations(kv, mom.ledgerId)).find((r) => r.id === hers.id)!;
    assertEquals([row.status, row.suggestion], ["to_cancel", null]);

    // A confirm proposal, declined by the owner.
    await asUser(kv, ids, me, "POST", S(other), { action: "confirm" });
    assertEquals((await asUser(kv, ids, mom, "DELETE", S(other))).status, 200);
    row = (await listReservations(kv, mom.ledgerId)).find((r) => r.id === other.id)!;
    assertEquals([row.status, row.suggestion], ["candidate", null]);

    // The proposer may withdraw their own; a later status change also clears one.
    await asUser(kv, ids, me, "POST", S(other), { action: "confirm" });
    assertEquals((await asUser(kv, ids, me, "DELETE", S(other))).status, 200);
    await asUser(kv, ids, me, "POST", S(other), { action: "confirm" });
    await asUser(kv, ids, mom, "POST", `${BASE}/${other.id}/confirm`);
    row = (await listReservations(kv, mom.ledgerId)).find((r) => r.id === other.id)!;
    assertEquals([row.status, row.suggestion], ["confirmed", null]);
  });
});

Deno.test("choose: what is only shared with me is proposed to its owner", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const hers = (await (await asUser(kv, ids, mom, "POST", BASE, {
      service: "ホテル白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
      endsAt: "2026-12-20",
    })).json()).reservation;
    const mine = (await (await asUser(kv, ids, me, "POST", BASE, {
      service: "おにやまホテル",
      startsAt: "2026-12-19T15:30:00+09:00",
      endsAt: "2026-12-20",
      confirmed: true,
    })).json()).reservation;
    await asUser(kv, ids, mom, "POST", `${BASE}/${hers.id}/members`, { q: "me@x.jp" });
    const out = await (await asUser(kv, ids, me, "POST", `${BASE}/${mine.id}/choose`, {
      over: [hers.id],
    })).json();
    assertEquals(
      out.needsOwner.map((n: { id: string; need: string; suggested?: boolean }) => [
        n.id,
        n.need,
        n.suggested,
      ]),
      [[hers.id, "cancel", true]],
    );
    const row = (await listReservations(kv, mom.ledgerId))[0]!;
    assertEquals([row.status, row.suggestion?.action], ["candidate", "cancel"]);
  });
});
