import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.19";
import {
  allowMagicSend,
  type AuthIds,
  consumeLineLinkCode,
  consumeMagicLink,
  createMagicLink,
  createSession,
  deleteAccount,
  deleteSession,
  ensureMailSecret,
  findUserByIcsSecret,
  findUserByLineUserId,
  findUserByMailSecret,
  getGcalEvent,
  getOrCreateUserByEmail,
  getSessionUser,
  getUser,
  issueLineLinkCode,
  LINE_CODE_TTL_MS,
  linkLineUser,
  looksLikeLineLinkCode,
  MAGIC_RATE_LIMIT,
  mailSecretFromAddress,
  rotateIcsSecret,
  rotateMailSecret,
  saveOauthState,
  setGcalEvent,
  takeOauthState,
  unlinkLineUser,
} from "../users.ts";

export function makeAuthIds(startMs = 1_000_000): AuthIds {
  let n = 0;
  let t = 0;
  return {
    newId: () => `ID${++n}`,
    nowIso: () => "2026-07-21T00:00:00.000Z",
    nowMs: () => startMs,
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

Deno.test("getOrCreateUserByEmail is idempotent and normalizes the address", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const a = await getOrCreateUserByEmail(kv, " Foo@Example.COM ", ids);
    const b = await getOrCreateUserByEmail(kv, "foo@example.com", ids);
    assertEquals(a.id, b.id);
    assertEquals(a.email, "foo@example.com");
    assertEquals((await findUserByIcsSecret(kv, a.icsSecret))?.id, a.id);
  });
});

Deno.test("sessions resolve until expiry; logout deletes", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds(1000);
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const sid = await createSession(kv, u.id, ids);
    assertEquals((await getSessionUser(kv, sid, 1000))?.id, u.id);
    // 91 days later the session is expired even if KV kept the record
    assertEquals(await getSessionUser(kv, sid, 1000 + 91 * 86_400_000), null);
    const sid2 = await createSession(kv, u.id, ids);
    await deleteSession(kv, sid2);
    assertEquals(await getSessionUser(kv, sid2, 1000), null);
  });
});

Deno.test("magic links are single-use and expire", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds(0);
    const tok = await createMagicLink(kv, "A@b.jp", ids);
    assertEquals(await consumeMagicLink(kv, tok, 60_000), "a@b.jp");
    assertEquals(await consumeMagicLink(kv, tok, 60_000), null); // spent
    const tok2 = await createMagicLink(kv, "a@b.jp", ids);
    assertEquals(await consumeMagicLink(kv, tok2, 16 * 60_000), null); // expired
  });
});

Deno.test("magic send rate limit stops after the cap", async () => {
  await withKv(async (kv) => {
    for (let i = 0; i < MAGIC_RATE_LIMIT; i++) {
      assertEquals(await allowMagicSend(kv, "x@y.jp"), true);
    }
    assertEquals(await allowMagicSend(kv, "x@y.jp"), false);
    assertEquals(await allowMagicSend(kv, "other@y.jp"), true);
  });
});

Deno.test("oauth state is single-use", async () => {
  await withKv(async (kv) => {
    await saveOauthState(kv, "st1", "ver1");
    assertEquals(await takeOauthState(kv, "st1"), { verifier: "ver1", linkUserId: null });
    assertEquals(await takeOauthState(kv, "st1"), null);
  });
});

Deno.test("rotateIcsSecret invalidates the old feed secret", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const next = await rotateIcsSecret(kv, u.id, ids);
    assertNotEquals(next?.icsSecret, u.icsSecret);
    assertEquals(await findUserByIcsSecret(kv, u.icsSecret), null);
    assertEquals((await findUserByIcsSecret(kv, next?.icsSecret ?? ""))?.id, u.id);
  });
});

// ---- mail intake address (メール転送, owner 2026-07-27) ----

Deno.test("mailSecretFromAddress reads the secret and rejects anything else", () => {
  assertEquals(mailSecretFromAddress("p-abc123@ferouhelee.resend.app"), "abc123");
  // Forwarding clients send display-name form.
  assertEquals(mailSecretFromAddress("plancel <P-abc123@ferouhelee.resend.app>"), "abc123");
  // The secret itself is never case-folded — it is the KV key.
  assertEquals(mailSecretFromAddress("p-AbC@x.test"), "AbC");
  assertEquals(mailSecretFromAddress("owner@gmail.com"), null);
  assertEquals(mailSecretFromAddress("p-@x.test"), null);
});

Deno.test("a new user gets an indexed mail secret; rotate retires the old one", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    assertEquals((await findUserByMailSecret(kv, u.mailSecret ?? ""))?.id, u.id);

    const next = await rotateMailSecret(kv, u.id, ids);
    assertNotEquals(next?.mailSecret, u.mailSecret);
    assertEquals(await findUserByMailSecret(kv, u.mailSecret ?? ""), null);
    assertEquals((await findUserByMailSecret(kv, next?.mailSecret ?? ""))?.id, u.id);
  });
});

// Accounts created before the feature carry no secret; the first read issues it.
Deno.test("ensureMailSecret backfills a pre-feature account exactly once", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    await kv.delete(["mail_secret", u.mailSecret ?? ""]);
    await kv.set(["webuser", u.id], { ...u, mailSecret: null });

    const issued = await ensureMailSecret(kv, u.id, ids);
    assertNotEquals(issued, null);
    assertEquals((await findUserByMailSecret(kv, issued ?? ""))?.id, u.id);
    assertEquals(await ensureMailSecret(kv, u.id, ids), issued); // idempotent
  });
});

Deno.test("deleteAccount drops the mail index so a forward cannot resolve", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    await deleteAccount(kv, u.id, ids);
    assertEquals(await findUserByMailSecret(kv, u.mailSecret ?? ""), null);
  });
});

// ---- per-user LINE linking (owner 2026-07-27) ----

/** `makeAuthIds().nowIso()` — the instant every link code is created at. */
const CODE_CREATED_MS = Temporal.Instant.from("2026-07-21T00:00:00.000Z").epochMilliseconds;

Deno.test("LINE link: round-trips, keeps the reverse index, and is idempotent", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    assertEquals(u.lineUserId, null);
    assertEquals(await findUserByLineUserId(kv, "U-a"), null);

    assertEquals(await linkLineUser(kv, u.id, "U-a", ids), "linked");
    assertEquals((await findUserByLineUserId(kv, "U-a"))?.id, u.id);
    assertEquals((await getUser(kv, u.id))?.lineUserId, "U-a");

    // Same pair again: no error, no change.
    assertEquals(await linkLineUser(kv, u.id, "U-a", ids), "linked");
    assertEquals((await findUserByLineUserId(kv, "U-a"))?.id, u.id);

    // Re-linking the same user to a DIFFERENT LINE id moves the index.
    assertEquals(await linkLineUser(kv, u.id, "U-b", ids), "linked");
    assertEquals(await findUserByLineUserId(kv, "U-a"), null);
    assertEquals((await findUserByLineUserId(kv, "U-b"))?.id, u.id);

    assertEquals(await linkLineUser(kv, "ID-nobody", "U-c", ids), "no_user");
  });
});

Deno.test("LINE link: a LINE id already linked to another user is rejected", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const a = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const b = await getOrCreateUserByEmail(kv, "b@b.jp", ids);
    assertEquals(await linkLineUser(kv, a.id, "U-shared", ids), "linked");
    assertEquals(await linkLineUser(kv, b.id, "U-shared", ids), "taken");
    // A refused link changes nothing on either side.
    assertEquals((await findUserByLineUserId(kv, "U-shared"))?.id, a.id);
    assertEquals((await getUser(kv, b.id))?.lineUserId, null);
  });
});

Deno.test("LINE unlink clears the reverse index", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    await linkLineUser(kv, u.id, "U-a", ids);
    await unlinkLineUser(kv, u.id, ids);
    assertEquals(await findUserByLineUserId(kv, "U-a"), null);
    assertEquals((await getUser(kv, u.id))?.lineUserId, null);
    // Unlinking twice is a no-op, and the id is free for another user.
    await unlinkLineUser(kv, u.id, ids);
    const other = await getOrCreateUserByEmail(kv, "b@b.jp", ids);
    assertEquals(await linkLineUser(kv, other.id, "U-a", ids), "linked");
  });
});

Deno.test("退会 clears the LINE index and any outstanding link code", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    await linkLineUser(kv, u.id, "U-a", ids);
    const code = await issueLineLinkCode(kv, u.id, ids) ?? "";
    await deleteAccount(kv, u.id, ids);
    assertEquals(await findUserByLineUserId(kv, "U-a"), null);
    assertEquals(await consumeLineLinkCode(kv, code, CODE_CREATED_MS), null);
  });
});

Deno.test("LINE link codes are typable, single-use, and expire after 10 min", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const code = await issueLineLinkCode(kv, u.id, ids) ?? "";
    assertEquals(code.length, 8);
    // Unambiguous alphabet: no O/0/I/l/1.
    assertEquals(/^[A-HJ-NP-Z2-9]{8}$/.test(code), true);
    assertEquals(looksLikeLineLinkCode(code), true);
    assertEquals(looksLikeLineLinkCode("確認"), false);

    // Case and stray spacing are forgiven; the code resolves once.
    const spaced = ` ${code.toLowerCase().slice(0, 4)} ${code.toLowerCase().slice(4)} `;
    assertEquals(await consumeLineLinkCode(kv, spaced, CODE_CREATED_MS), u.id);
    assertEquals(await consumeLineLinkCode(kv, code, CODE_CREATED_MS), null); // spent

    // A fresh code past its TTL does not link (and is still consumed).
    const stale = await issueLineLinkCode(kv, u.id, ids) ?? "";
    assertEquals(
      await consumeLineLinkCode(kv, stale, CODE_CREATED_MS + LINE_CODE_TTL_MS + 1),
      null,
    );
    assertEquals(await consumeLineLinkCode(kv, "ABCDEFGH", CODE_CREATED_MS), null); // never issued
  });
});

Deno.test("issuing a LINE link code invalidates the previous one", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const first = await issueLineLinkCode(kv, u.id, ids) ?? "";
    const second = await issueLineLinkCode(kv, u.id, ids) ?? "";
    assertNotEquals(first, second);
    assertEquals(await consumeLineLinkCode(kv, first, CODE_CREATED_MS), null);
    assertEquals(await consumeLineLinkCode(kv, second, CODE_CREATED_MS), u.id);
    assertEquals(await issueLineLinkCode(kv, "ID-nobody", ids), null);
  });
});

Deno.test("gcal mapping set/get round-trips", async () => {
  await withKv(async (kv) => {
    await setGcalEvent(kv, "U1", "R1", { eventId: "E1", syncedAt: "2026-07-21T00:00:00Z" });
    assertEquals((await getGcalEvent(kv, "U1", "R1"))?.eventId, "E1");
    assertEquals(await getGcalEvent(kv, "U1", "R2"), null);
  });
});
