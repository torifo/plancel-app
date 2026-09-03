import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { extractDateTimes } from "../rules.ts";

const summer = new VirtualClock("2026-07-16T00:00:00Z"); // 2026-07-16 JST
const late = new VirtualClock("2026-08-20T00:00:00Z"); // 2026-08-20 JST

// The corpus, read by the rules alone. Each expectation is the fixture's
// hand-checked `truth`, not a recording.
Deno.test("rules: a stated year is taken as written, with the time attached", () => {
  const r = extractDateTimes(
    "【ご予約確認】鮨さいとう 東京店 2026年8月15日(土) 19:00〜 2名様 おまかせコース 16,500円/名",
    summer,
  );
  assertEquals(r.starts_at, "2026-08-15T19:00:00+09:00");
  assertEquals(r.ends_at, null);
  assertEquals(r.dates, ["2026-08-15"]);
});

Deno.test("rules: a check-in and a checkout become a range; the year carries forward", () => {
  const r = extractDateTimes(
    "【楽天トラベル】予約内容 / 城崎温泉 ゆらり庵（兵庫県豊岡市城崎町湯島456）チェックイン 2026年11月3日 15:00 / チェックアウト 11月4日 10:00 / 大人2名 28,600円",
    summer,
  );
  assertEquals(r.starts_at, "2026-11-03T15:00:00+09:00");
  assertEquals(r.ends_at, "2026-11-04T10:00:00+09:00");
  assertEquals(r.dates, ["2026-11-03", "2026-11-04"]);
});

Deno.test("rules: a 〜 range without times is a stay from midnight to midnight", () => {
  const r = extractDateTimes(
    "じゃらんnet 予約完了のお知らせ / 湖畔の湯宿 蛍 2026年9月20日(日)〜9月21日(月) 1泊2食付き 大人2名 合計36,000円",
    summer,
  );
  assertEquals(r.starts_at, "2026-09-20T00:00:00+09:00");
  assertEquals(r.ends_at, "2026-09-21T00:00:00+09:00");
});

Deno.test("rules: a year-less date is the next one on or after today", () => {
  // 8/20 with today 7/16: this year.
  assertEquals(
    extractDateTimes(
      "予約確認: とり多津 浅草店（東京都台東区雷門2-3-4）8/20(木) 18:30〜 4名様",
      summer,
    )
      .starts_at,
    "2026-08-20T18:30:00+09:00",
  );
  // 1/15 with today 8/20: next year.
  assertEquals(
    extractDateTimes("1/15 19時 きんくら 新年会で仮押さえ 6名", late).starts_at,
    "2027-01-15T19:00:00+09:00",
  );
  // 8/1 19時 with today 7/16: this year, 「時」 read as a time.
  assertEquals(
    extractDateTimes("8/1 19時に炭火焼鳥 とり多津 4人で仮押さえした", summer).starts_at,
    "2026-08-01T19:00:00+09:00",
  );
});

Deno.test("rules: a date on its own line with a label in front still reads", () => {
  const r = extractDateTimes(
    "【食べログ】ご予約確定のお知らせ\n焼肉 三田家\nご来店日時: 2026年8月15日(土) 19:00\nご人数: 4名",
    summer,
  );
  assertEquals(r.starts_at, "2026-08-15T19:00:00+09:00");
});

Deno.test("rules: a weekday alone is not a date, and nothing is guessed", () => {
  assertEquals(extractDateTimes("土曜19時に◯◯を仮予約、前日まで無料", summer), {
    starts_at: null,
    ends_at: null,
    dates: [],
  });
});

Deno.test("rules: money, counts and deadlines are not dates", () => {
  const r = extractDateTimes("16,500円/名 2名様 3日前まで無料、前日18時まで 当日100%", summer);
  assertEquals(r.dates, []);
  // 「8/15 2名」: a date, but 「2名」 is not a time.
  assertEquals(extractDateTimes("8/15 2名", summer).starts_at, "2026-08-15T00:00:00+09:00");
});

Deno.test("rules: 午後 and 半 are read; an impossible time is dropped, not invented", () => {
  assertEquals(
    extractDateTimes("8月15日 午後7時半", summer).starts_at,
    "2026-08-15T19:30:00+09:00",
  );
  assertEquals(extractDateTimes("8月15日 午前12時", summer).starts_at, "2026-08-15T00:00:00+09:00");
  assertEquals(extractDateTimes("8月15日 25時", summer).starts_at, "2026-08-15T00:00:00+09:00");
});

Deno.test("rules: two dates that are not tied stay two dates, not a range", () => {
  const r = extractDateTimes("8月15日 19:00 のご予約。8月10日までにご連絡ください。", summer);
  assertEquals(r.starts_at, "2026-08-15T19:00:00+09:00");
  assertEquals(r.ends_at, null);
  assertEquals(r.dates, ["2026-08-15", "2026-08-10"]);
});

Deno.test("rules: a checkout that rolls past New Year lands in the next year", () => {
  const r = extractDateTimes("チェックイン 12月31日 15:00 チェックアウト 1月1日 10:00", late);
  assertEquals(r.starts_at, "2026-12-31T15:00:00+09:00");
  assertEquals(r.ends_at, "2027-01-01T10:00:00+09:00");
});

Deno.test("rules: full-width digits and slashes read the same as half-width", () => {
  assertEquals(
    extractDateTimes("８月１５日（土）１９：００", summer).starts_at,
    "2026-08-15T19:00:00+09:00",
  );
});
