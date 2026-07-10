import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { signLineBody, verifyLineSignature } from "../signature.ts";

const SECRET = "test-channel-secret";
const BODY = '{"events":[{"type":"message"}]}';

Deno.test("verifyLineSignature: accepts the signature LINE would compute", async () => {
  const signature = await signLineBody(SECRET, BODY);
  assertEquals(await verifyLineSignature(SECRET, BODY, signature), true);
});

Deno.test("verifyLineSignature: rejects a tampered body", async () => {
  const signature = await signLineBody(SECRET, BODY);
  assertEquals(await verifyLineSignature(SECRET, BODY + " ", signature), false);
});

Deno.test("verifyLineSignature: rejects a wrong secret", async () => {
  const signature = await signLineBody("other-secret", BODY);
  assertEquals(await verifyLineSignature(SECRET, BODY, signature), false);
});

Deno.test("verifyLineSignature: rejects missing/empty header", async () => {
  assertEquals(await verifyLineSignature(SECRET, BODY, null), false);
  assertEquals(await verifyLineSignature(SECRET, BODY, ""), false);
});
