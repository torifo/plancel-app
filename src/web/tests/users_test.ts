import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.19";
import {
  allowMagicSend,
  type AuthIds,
  consumeMagicLink,
  createMagicLink,
  createSession,
  deleteSession,
  findUserByIcsSecret,
  getGcalEvent,
  getOrCreateUserByEmail,
  getSessionUser,
  MAGIC_RATE_LIMIT,
  rotateIcsSecret,
  saveOauthState,
  setGcalEvent,
  takeOauthState,
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

Deno.test("gcal mapping set/get round-trips", async () => {
  await withKv(async (kv) => {
    await setGcalEvent(kv, "U1", "R1", { eventId: "E1", syncedAt: "2026-07-21T00:00:00Z" });
    assertEquals((await getGcalEvent(kv, "U1", "R1"))?.eventId, "E1");
    assertEquals(await getGcalEvent(kv, "U1", "R2"), null);
  });
});
