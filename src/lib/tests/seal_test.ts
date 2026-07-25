import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { b64encode } from "../encoding.ts";
import { seal, unseal } from "../seal.ts";

const KEK = b64encode(new Uint8Array(32).fill(7));

Deno.test("seal/unseal round-trips with a KEK", async () => {
  const sealed = await seal("refresh-token-secret", KEK);
  assertEquals(sealed.startsWith("v1:"), true);
  assertEquals(await unseal(sealed, KEK), "refresh-token-secret");
});

Deno.test("seal without a KEK falls back to plain: (and unseals)", async () => {
  const sealed = await seal("s3cret", undefined);
  assertEquals(sealed, "plain:s3cret");
  assertEquals(await unseal(sealed, undefined), "s3cret");
  // plain: values stay readable even after a KEK is configured
  assertEquals(await unseal(sealed, KEK), "s3cret");
});

Deno.test("unseal rejects sealed values when the KEK is missing or wrong", async () => {
  const sealed = await seal("x", KEK);
  await assertRejects(() => unseal(sealed, undefined));
  await assertRejects(() => unseal(sealed, b64encode(new Uint8Array(32).fill(9))));
  await assertRejects(() => unseal("v2:???", KEK));
});
