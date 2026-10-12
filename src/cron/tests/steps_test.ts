import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { runSteps } from "../steps.ts";

function captureLog() {
  const lines: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
  return {
    lines,
    log: {
      error: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
    },
  };
}

Deno.test("runSteps: a step that throws is logged and the later steps still run", async () => {
  const ran: string[] = [];
  const { lines, log } = captureLog();
  const failed = await runSteps([
    { name: "tick", run: () => Promise.resolve(void ran.push("tick")) },
    { name: "deadline sweep", run: () => Promise.reject(new Error("boom")) },
    {
      name: "gcal sweep",
      run: () => {
        throw new Error("sync throw"); // a synchronous throw is isolated too
      },
    },
    { name: "provider canary", run: () => Promise.resolve(void ran.push("canary")) },
  ], log);

  assertEquals(ran, ["tick", "canary"]);
  assertEquals(failed, ["deadline sweep", "gcal sweep"]);
  assertEquals(lines.map((l) => l.msg), ["deadline sweep failed", "gcal sweep failed"]);
  assertEquals(lines[0]?.fields, { err: "Error: boom" });
});

Deno.test("runSteps: steps run in order, one at a time", async () => {
  const events: string[] = [];
  const step = (name: string) => ({
    name,
    run: async () => {
      events.push(`${name}:start`);
      await Promise.resolve();
      events.push(`${name}:end`);
    },
  });
  const { log } = captureLog();
  assertEquals(await runSteps([step("a"), step("b")], log), []);
  assertEquals(events, ["a:start", "a:end", "b:start", "b:end"]);
});
