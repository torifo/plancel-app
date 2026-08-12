import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.19";
import { finishedAtMs, isFinished } from "../lifecycle.ts";

const ms = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;
/** 終わる日の終わり（JST）。 */
const eod = (day: string) => ms(`${day}T23:59:59.999+09:00`);

Deno.test("finishedAtMs: without endsAt the start's own day is the end", () => {
  // 19:00 の食事はその日いっぱい台帳に残る。開始時刻で終わりにすると、まだ
  // 今日の予定なのに履歴へ落ちる。
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T19:00:00+09:00", endsAt: null }),
    eod("2026-08-20"),
  );
  // 00:30 開始でも同じ日の終わり（前日の夜遅くに見える予約を早めに畳まない）。
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T00:30:00+09:00", endsAt: null }),
    eod("2026-08-20"),
  );
});

Deno.test("finishedAtMs: endsAt is the checkout, and it decides the day", () => {
  // 連泊は開始日で終わってはいけない。チェックアウト 8/23 10:00 なら 8/23 いっぱい。
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T15:00:00+09:00", endsAt: "2026-08-23T10:00:00+09:00" }),
    eod("2026-08-23"),
  );
  // 同日中に終わる予約（開始19:00・終了21:00）は開始日の終わりと同じ。
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T19:00:00+09:00", endsAt: "2026-08-20T21:00:00+09:00" }),
    eod("2026-08-20"),
  );
});

Deno.test("finishedAtMs: an endsAt before the start is a bad parse, not a shorter stay", () => {
  // 逆転した終了日で未来の予約を隠さない。遅い方＝開始日を採る。
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T15:00:00+09:00", endsAt: "2026-07-01T10:00:00+09:00" }),
    eod("2026-08-20"),
  );
});

Deno.test("finishedAtMs: unreadable input falls back instead of throwing", () => {
  // store は startsAt を z.string() で持ち、endsAt は LLM 由来。1件の壊れた値で
  // 一覧描画や LINE の返信が落ちてはいけない。
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T19:00:00+09:00", endsAt: "来週の金曜" }),
    eod("2026-08-20"),
  );
  assertEquals(
    finishedAtMs({ startsAt: "2026-08-20T19:00:00+09:00", endsAt: "" }),
    eod("2026-08-20"),
  );
  // 開始が読めない予約は「ずっと未来」＝台帳に残す。間違って見えている方が、
  // 間違って履歴に片付けられるよりましなので。
  assertEquals(finishedAtMs({ startsAt: "???", endsAt: null }), Number.POSITIVE_INFINITY);
  assertEquals(
    finishedAtMs({ startsAt: "???", endsAt: "2026-08-23T10:00:00+09:00" }),
    eod("2026-08-23"),
  );
});

Deno.test("isFinished: the boundary instant itself is not finished yet", () => {
  const r = { startsAt: "2026-08-20T19:00:00+09:00", endsAt: null };
  assertFalse(isFinished(r, eod("2026-08-20"))); // 23:59:59.999 はまだ終わっていない
  assert(isFinished(r, eod("2026-08-20") + 1)); // 翌 00:00 で終わり
  assertFalse(isFinished(r, ms("2026-08-20T23:00:00+09:00")));
  assertFalse(isFinished(r, ms("2026-08-01T09:00:00+09:00")));
  assert(isFinished(r, ms("2026-08-21T00:00:00+09:00")));
});

Deno.test("isFinished: a stay is upcoming through its last night", () => {
  const stay = { startsAt: "2026-08-20T15:00:00+09:00", endsAt: "2026-08-23T10:00:00+09:00" };
  assert(!isFinished(stay, ms("2026-08-21T12:00:00+09:00"))); // 滞在中
  assertFalse(isFinished(stay, ms("2026-08-23T10:00:00+09:00"))); // チェックアウト直後も当日は残す
  assert(isFinished(stay, ms("2026-08-24T00:00:00+09:00")));
});
