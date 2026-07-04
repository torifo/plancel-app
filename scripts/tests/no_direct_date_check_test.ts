import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { checkNoDirectDate } from "../no_direct_date_check.ts";

Deno.test("no_direct_date_check: passes on clean src/", async () => {
  const violations = await checkNoDirectDate("src");
  assertEquals(violations, []);
});

Deno.test("no_direct_date_check: flags new Date() in a fixture file outside the allowlist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fixturePath = `${dir}/offender.ts`;
    await Deno.writeTextFile(
      fixturePath,
      "export function bad() {\n  return new Date();\n}\n",
    );

    const violations = await checkNoDirectDate(dir);
    assertEquals(violations.length, 1);
    assert(violations[0] !== undefined);
    assertEquals(violations[0].line, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("no_direct_date_check: flags Date.now() and Temporal.Now", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/offender2.ts`,
      "const a = Date.now();\nconst b = Temporal.Now.instant();\n",
    );

    const violations = await checkNoDirectDate(dir);
    assertEquals(violations.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
