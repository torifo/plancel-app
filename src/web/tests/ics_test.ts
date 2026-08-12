import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { buildIcs, handleCalendarFeed, startsAtToInstant } from "../calendar/ics.ts";
import { eventBody } from "../calendar/gcal.ts";
import { createReservation, type WebReservation } from "../store.ts";
import { getOrCreateUserByEmail } from "../users.ts";
import { makeAuthIds } from "./users_test.ts";

const resv = (over: Partial<WebReservation>): WebReservation => ({
  id: "R1",
  plan: null,
  service: "宿A",
  startsAt: "2026-08-01T19:00:00+09:00",
  endsAt: null,
  amount: 8000,
  location: null,
  policy: "free24",
  status: "confirmed",
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
  updated_by: null,
  ...over,
});

Deno.test("startsAtToInstant: offset kept, offsetless read as JST, junk -> null", () => {
  assertEquals(String(startsAtToInstant("2026-08-01T19:00:00+09:00")), "2026-08-01T10:00:00Z");
  assertEquals(String(startsAtToInstant("2026-08-01T19:00")), "2026-08-01T10:00:00Z");
  assertEquals(startsAtToInstant("not a date"), null);
});

Deno.test("buildIcs emits only confirmed reservations, UTC times, escaped text", () => {
  const ics = buildIcs([
    resv({}),
    resv({ id: "R2", status: "candidate", service: "宿B" }),
    resv({ id: "R3", status: "cancelled" }),
    resv({ id: "R4", service: "escape;me, ok", plan: "夏旅" }),
  ]);
  assertEquals(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assertStringIncludes(ics, "DTSTART:20260801T100000Z");
  assertStringIncludes(ics, "DTEND:20260801T110000Z");
  assertStringIncludes(ics, "UID:R1@plancel");
  assertStringIncludes(ics, "SUMMARY:escape\\;me\\, ok");
  assertStringIncludes(ics, "プラン: 夏旅");
  assertEquals(ics.includes("宿B"), false);
});

// カレンダーに出るのは人が読む規定ラベル（生の値だと段階表がJSONで漏れる）。
Deno.test("calendar descriptions carry the human policy label, never the raw value", () => {
  assertStringIncludes(buildIcs([resv({})]), "キャンセル規定: 前日まで無料 → 当日100%");
  const custom = resv({
    policy: { stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }, { h: 0, pct: 100 }] },
  });
  assertStringIncludes(
    buildIcs([custom]),
    "キャンセル規定: 5日前まで無料 → 3日前まで30% → 当日100%",
  );
  assertEquals(buildIcs([custom]).includes("stages"), false);
  assertStringIncludes(
    String((eventBody(custom) as { description: string }).description),
    "キャンセル規定: 5日前まで無料 → 3日前まで30% → 当日100%",
  );
  assertStringIncludes(buildIcs([resv({ policy: "unknown", status: "confirmed" })]), "規定: 不明");
});

Deno.test("location lands in ICS LOCATION and the Google event body", () => {
  const withLoc = resv({ location: "長野県諏訪市湖岸通り1-2-3" });
  const ics = buildIcs([withLoc]);
  assertStringIncludes(ics, "LOCATION:長野県諏訪市湖岸通り1-2-3");
  assertEquals(buildIcs([resv({})]).includes("LOCATION:"), false);
  assertEquals(
    (eventBody(withLoc) as { location?: string }).location,
    "長野県諏訪市湖岸通り1-2-3",
  );
  assertEquals("location" in eventBody(resv({})), false);
});

Deno.test("feed handler: valid secret serves the user's ledger, bad secret 404s", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const ids = makeAuthIds();
    const user = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    await createReservation(kv, user.ledgerId, {
      plan: null,
      service: "レストラン",
      startsAt: "2026-09-01T12:00:00+09:00",
      endsAt: null,
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: true,
    }, ids);
    const ok = await handleCalendarFeed(
      kv,
      new Request(`https://app.test/calendar/${user.icsSecret}.ics`),
    );
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get("content-type"), "text/calendar; charset=utf-8");
    assertStringIncludes(await ok.text(), "レストラン");

    const bad = await handleCalendarFeed(kv, new Request("https://app.test/calendar/nope.ics"));
    assertEquals(bad.status, 404);
  } finally {
    kv.close();
  }
});

// 連泊は台帳が持っているチェックアウトまで伸ばす。持っていなかった頃の1時間固定を
// そのままにすると、3泊の旅行がチェックイン日の1時間の予定として書き出される。
Deno.test("calendar events run to the checkout, or an hour when there is none", () => {
  const stay = resv({ startsAt: "2026-08-01T15:00:00+09:00", endsAt: "2026-08-04T10:00:00+09:00" });
  const ics = buildIcs([stay]);
  assertStringIncludes(ics, "DTSTART:20260801T060000Z");
  assertStringIncludes(ics, "DTEND:20260804T010000Z");
  assertEquals(
    (eventBody(stay) as { end: { dateTime: string } }).end.dateTime,
    "2026-08-04T01:00:00Z",
  );

  // endsAt 無しは従来どおり1時間。
  assertStringIncludes(buildIcs([resv({})]), "DTEND:20260801T110000Z");

  // 開始と同じか手前の endsAt は誤パース。終わりが始まりより前の予定はカレンダー
  // 側が拒むことがあるので、1時間に落とす。
  for (const bad of ["2026-08-01T19:00:00+09:00", "2026-07-01T10:00:00+09:00", "来週の金曜"]) {
    const r = resv({ startsAt: "2026-08-01T19:00:00+09:00", endsAt: bad });
    assertEquals(
      (eventBody(r) as { end: { dateTime: string } }).end.dateTime,
      "2026-08-01T11:00:00Z",
      `endsAt=${bad} は1時間に落ちる`,
    );
  }
});
