import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import {
  normalizeInstant,
  normalizeRequiredInstant,
  readableInstantSchema,
  toInstantOrNull,
} from "../instant.ts";

Deno.test("toInstantOrNull: an offset is honoured, a missing one reads as JST", () => {
  assertEquals(String(toInstantOrNull("2026-08-05T10:00:00+09:00")), "2026-08-05T01:00:00Z");
  assertEquals(String(toInstantOrNull("2026-08-05T01:00:00Z")), "2026-08-05T01:00:00Z");
  // 確認メールが「8月5日 10:00」しか書いていないときにモデルが返す形。
  assertEquals(String(toInstantOrNull("2026-08-05T10:00")), "2026-08-05T01:00:00Z");
  // 日付だけなら JST のその日の始まり。
  assertEquals(String(toInstantOrNull("2026-08-05")), "2026-08-04T15:00:00Z");
  // 時だけのオフセット。Temporal は受けるが Date.parse は読めないので、
  // 正規化しないままだとブラウザとサーバで判定が分かれる。
  assertEquals(String(toInstantOrNull("2026-08-05T10:00:00+09")), "2026-08-05T01:00:00Z");
  assertEquals(String(toInstantOrNull("2026-08-05T01:00:00z")), "2026-08-05T01:00:00Z");
});

Deno.test("toInstantOrNull: unreadable input is null, not a throw", () => {
  for (const bad of ["来週の金曜", "", "   ", "2026-13-45T99:99", null, undefined, 42, {}]) {
    assertEquals(toInstantOrNull(bad), null, `${JSON.stringify(bad)} は読めない`);
  }
});

Deno.test("normalizeInstant: canonical string, or null for an optional field", () => {
  assertEquals(normalizeInstant("2026-08-05T10:00"), "2026-08-05T01:00:00.000Z");
  assertEquals(normalizeInstant("2026-08-05T10:00:00+09"), "2026-08-05T01:00:00.000Z");
  assertEquals(normalizeInstant(null), null);
  assertEquals(normalizeInstant("来週の金曜"), null);
});

Deno.test("normalizeRequiredInstant: an unreadable start is kept, never dropped", () => {
  assertEquals(normalizeRequiredInstant("2026-08-05T10:00"), "2026-08-05T01:00:00.000Z");
  // 落とすと予約がどの一覧にも出なくなる。見えていて間違っている方が直せる。
  assertEquals(normalizeRequiredInstant("来週の金曜"), "来週の金曜");
});

Deno.test("readableInstantSchema: rejects what no reader can parse, with the accepted shape", () => {
  const ok = readableInstantSchema.safeParse("2026-10-27T19:00:00+09:00");
  assertEquals(ok.success, true);
  // The model's "10月27日 19時" and the browser-only "2026/10/27 19:00" (issue #2):
  // Date.parse reads the latter, Temporal does not, so the row would look fine on
  // the phone while the server could not sort it or compute its deadline.
  for (const bad of ["10月27日 19時", "来週の金曜", "2026/10/27 19:00", ""]) {
    const r = readableInstantSchema.safeParse(bad);
    assertEquals(r.success, false, `${bad} は受け付けない`);
    if (!r.success) {
      assertStringIncludes(r.error.issues[0]!.message, "2026-10-27T19:00:00+09:00");
      assertStringIncludes(r.error.issues[0]!.message, "JST");
    }
  }
});
