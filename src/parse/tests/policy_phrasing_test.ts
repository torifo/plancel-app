import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.19";
import { impliedFreeBoundaryHours, statesFeeFromBoundary } from "../policy-phrasing.ts";

Deno.test("impliedFreeBoundaryHours: a day named as charged ends the free window a day earlier", () => {
  // 3日前 is itself a charged day, so the last free moment is 4日前 = 96h.
  assertEquals(impliedFreeBoundaryHours("キャンセル: 3日前から20%、前日50%、当日80%"), 96);
  assertEquals(impliedFreeBoundaryHours("キャンセル料は7日前より20%頂戴します"), 192);
  assertEquals(impliedFreeBoundaryHours("キャンセル規定: 前日から50%"), 48);
  assertEquals(impliedFreeBoundaryHours("キャンセルは当日以降100%"), 24); // = free24
  // Several from-boundaries: the outermost is where the free window ends.
  assertEquals(impliedFreeBoundaryHours("取消料 30日前から10%、7日前から50%"), 744);
});

Deno.test("impliedFreeBoundaryHours: an hour boundary is an instant and stands as written", () => {
  assertEquals(impliedFreeBoundaryHours("解約は36時間前から有料です"), 36);
  // 48 divides by 24 but was written in hours — the unit has to come from the
  // text, not from whether the number happens to look like whole days.
  assertEquals(impliedFreeBoundaryHours("キャンセルは48時間前から50%"), 48);
});

Deno.test("impliedFreeBoundaryHours: full-width digits read the same as ASCII", () => {
  // 予約サイトの規定は全角で書かれていることがある。`\d` は ASCII だけなので、
  // 正規化しないと補正が黙って効かなくなる（＝モデルの答えがそのまま通る）。
  assertEquals(impliedFreeBoundaryHours("キャンセルは３日前から２０％"), 96);
  assertEquals(impliedFreeBoundaryHours("キャンセルは７日前から２０％"), 192);
});

Deno.test("impliedFreeBoundaryHours: a stated free deadline is left alone", () => {
  // 「まで無料」 names the last free moment itself — shifting it off the inner
  // 「から」 boundary would move a deadline the facility spelled out.
  assertEquals(impliedFreeBoundaryHours("キャンセル規定: 7日前まで無料、3日前から50%"), null);
  assertEquals(impliedFreeBoundaryHours("前日18時までキャンセル無料、以降キャンセル料100%"), null);
  assertEquals(impliedFreeBoundaryHours("キャンセル: 7日前まで無料、3日前まで30%、当日100%"), null);
});

Deno.test("impliedFreeBoundaryHours: ordinary prose carrying から is not a policy", () => {
  // 「から」 is far too common a particle to key off on its own, and every false
  // match costs one of Gemini's 20 requests/day.
  assertEquals(impliedFreeBoundaryHours("東京駅から徒歩5分 / キャンセルは有料です"), null);
  assertEquals(impliedFreeBoundaryHours("10:00からチェックイン可能。キャンセル規定あり"), null);
  assertEquals(impliedFreeBoundaryHours("3日前から満席のためキャンセル待ちです"), null);
  assertEquals(impliedFreeBoundaryHours("8月1日から営業"), null);
  assertEquals(impliedFreeBoundaryHours("2名 8000円のコース"), null);
});

Deno.test("impliedFreeBoundaryHours: a discount is not a cancellation fee", () => {
  // A false match here overrides the deadline the ledger shows, so a percentage
  // that turns out to be money OFF must not look like money charged.
  assertEquals(impliedFreeBoundaryHours("キャンセル規定あり / 3日前から20%オフ"), null);
  assertEquals(impliedFreeBoundaryHours("キャンセル規定あり / 7日前から10%割引"), null);
  assertEquals(impliedFreeBoundaryHours("キャンセル規定あり / 前日から500円還元"), null);
  // …but the same shape with a real fee still reads.
  assertEquals(impliedFreeBoundaryHours("キャンセルは3日前から20%"), 96);
});

Deno.test("statesFeeFromBoundary mirrors impliedFreeBoundaryHours", () => {
  assert(statesFeeFromBoundary("キャンセル: 3日前から20%"));
  assert(statesFeeFromBoundary("キャンセルは当日以降100%"));
  assertFalse(statesFeeFromBoundary("キャンセル規定: 7日前まで無料、当日100%"));
});
