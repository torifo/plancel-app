import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { maskPii } from "../pii-mask.ts";

Deno.test("maskPii masks a hyphenated mobile number (090-1234-5678)", () => {
  const { masked, found } = maskPii("電話は090-1234-5678までお願いします");
  assertEquals(masked, "電話は[MASKED_PHONE_1]までお願いします");
  assertEquals(found, [{ kind: "phone", original: "090-1234-5678" }]);
});

Deno.test("maskPii masks a landline format (03-1234-5678)", () => {
  const { masked, found } = maskPii("担当: 03-1234-5678");
  assertEquals(masked, "担当: [MASKED_PHONE_1]");
  assertEquals(found, [{ kind: "phone", original: "03-1234-5678" }]);
});

Deno.test("maskPii masks a +81 international format", () => {
  const { masked, found } = maskPii("+81-90-1234-5678 に連絡");
  assertEquals(masked, "[MASKED_PHONE_1] に連絡");
  assertEquals(found, [{ kind: "phone", original: "+81-90-1234-5678" }]);
});

Deno.test("maskPii masks an unhyphenated 11-digit number", () => {
  const { masked, found } = maskPii("09012345678 まで");
  assertEquals(masked, "[MASKED_PHONE_1] まで");
  assertEquals(found, [{ kind: "phone", original: "09012345678" }]);
});

Deno.test("maskPii masks an email address", () => {
  const { masked, found } = maskPii("連絡先: taro.yamada@example.co.jp です");
  assertEquals(masked, "連絡先: [MASKED_EMAIL_1] です");
  assertEquals(found, [{ kind: "email", original: "taro.yamada@example.co.jp" }]);
});

Deno.test("maskPii masks multiple occurrences with distinct placeholders (emails numbered before phones)", () => {
  const { masked, found } = maskPii(
    "090-1234-5678 / taro@example.com / 03-1111-2222",
  );
  // Emails are masked in a first pass (numbered first), phones in a second
  // pass — placeholder numbers reflect masking-pass order, not left-to-right
  // position in the text.
  assertEquals(masked, "[MASKED_PHONE_2] / [MASKED_EMAIL_1] / [MASKED_PHONE_3]");
  assertEquals(found.length, 3);
  assertEquals(found[0], { kind: "email", original: "taro@example.com" });
  assertEquals(found[1], { kind: "phone", original: "090-1234-5678" });
  assertEquals(found[2], { kind: "phone", original: "03-1111-2222" });
});

Deno.test("maskPii leaves text without PII untouched", () => {
  const { masked, found } = maskPii("土曜19時に○○を仮予約、前日まで無料");
  assertEquals(masked, "土曜19時に○○を仮予約、前日まで無料");
  assertEquals(found, []);
});
