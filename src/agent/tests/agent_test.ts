import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { getReservation, listReservations } from "../../web/store.ts";
import { deleteAccount } from "../../web/users.ts";
import { GeminiTransportError } from "../gemini.ts";
import { MAX_TOOL_CALLS, runAgentForUser, UNCHANGED_RECHECK_MS } from "../runner.ts";
import { acquireRunLock, listProposals, listRuns, MANUAL_RUNS_PER_HOUR } from "../store.ts";
import { tokenMatches } from "../routes.ts";
import {
  call,
  fcResponse,
  lastToolResult,
  say,
  ScriptedModel,
  sensibleModel,
  TOKEN,
  withWorld,
} from "./fixtures.ts";

const ALBA = "トラットリア アルバ";
const SUSHI = "鮨 さいとう";

Deno.test("a run observes, decides and proposes cancelling the losing candidate, and cancels nothing", async () => {
  await withWorld(async (w) => {
    const model = sensibleModel();
    const res = await call(w.deps(model), "POST", "/api/agent/run", w.demo);
    assertEquals(res.status, 200);
    const { run } = await res.json();

    assertEquals(run.status, "ok");
    assertEquals(run.trigger, "manual");
    assertEquals(run.model, "fake-model");
    assertEquals(run.toolCalls, 2);
    // The decision log reads observe → decide → act, each with its tool and a short result.
    assertEquals(run.steps.map((s: { phase: string }) => s.phase), ["observe", "decide", "act"]);
    assertEquals(run.steps[0].tool, "list_reservations");
    assertEquals(run.steps[2].tool, "propose_cancellation");
    assertStringIncludes(run.steps[2].result, ALBA);
    assertStringIncludes(run.summary, "提案");

    assertEquals(run.proposals.length, 1);
    const p = run.proposals[0];
    assertEquals(p.service, ALBA);
    assertEquals(p.status, "pending");
    assertStringIncludes(p.draftMessage, "キャンセル");
    // Loss figures come from the ledger's policy math, not from the model:
    // free tonight, then 50% of ¥16,000.
    assertEquals(p.estimate.lossNowYen, 0);
    assertEquals(p.estimate.lossAfterNextBoundaryYen, 8000);
    assertStringIncludes(p.estimate.freeUntil, "+09:00");

    // A proposal is not a cancellation.
    const alba = (await listReservations(w.kv, w.demo.ledgerId)).find((r) => r.service === ALBA)!;
    assertEquals(alba.status, "to_cancel");

    // What the model was shown: JST, the deadline, and who it competes with.
    const listed = lastToolResult(model.requests[1]!, "list_reservations")!;
    const shown = (listed.reservations as Record<string, unknown>[]).find((r) =>
      r.service === ALBA
    )!;
    assertStringIncludes(String(listed.now), "+09:00");
    assertStringIncludes(String(shown.startsAt), "+09:00");
    assertStringIncludes(String(shown.freeUntil), "+09:00");
    assert(typeof shown.hoursToFreeUntil === "number" && shown.hoursToFreeUntil < 24);
    const rivals = (shown.conflictsWith as { service: string; why: string }[]).map((c) =>
      c.service
    );
    assert(rivals.includes(SUSHI));
    // The finished dinner and anything cancelled are not offered.
    assert(
      !(listed.reservations as { service: string }[]).some((r) => r.service === "炭火焼き とり吉"),
    );
  });
});

Deno.test("approving a proposal cancels the reservation through the ledger, once, for its owner only", async () => {
  await withWorld(async (w) => {
    const deps = w.deps(sensibleModel());
    const { run } = await (await call(deps, "POST", "/api/agent/run", w.demo)).json();
    const id = run.proposals[0].id;

    // Someone else's session cannot see or decide it.
    assertEquals(
      (await call(deps, "POST", `/api/agent/proposals/${id}/approve`, w.other)).status,
      404,
    );
    assertEquals((await call(deps, "POST", `/api/agent/proposals/${id}/approve`)).status, 401);
    const before = await getReservation(w.kv, w.demo.ledgerId, run.proposals[0].reservationId);
    assertEquals(before?.status, "to_cancel");

    let synced = "";
    const approve = await call(
      w.deps(null, { onMutate: (_u, rid) => (synced = rid) }),
      "POST",
      `/api/agent/proposals/${id}/approve`,
      w.demo,
    );
    assertEquals(approve.status, 200);
    const body = await approve.json();
    assertEquals(body.proposal.status, "approved");
    assertEquals(body.reservation.status, "cancelled");
    assertEquals(synced, run.proposals[0].reservationId);
    const after = await getReservation(w.kv, w.demo.ledgerId, run.proposals[0].reservationId);
    assertEquals(after?.status, "cancelled");
    assertEquals(after?.updated_by, w.demo.id);
    // The confirmed booking was not touched.
    const rows = await listReservations(w.kv, w.demo.ledgerId);
    assertEquals(rows.find((r) => r.service === SUSHI)?.status, "confirmed");

    // Deciding twice is refused.
    assertEquals(
      (await call(deps, "POST", `/api/agent/proposals/${id}/approve`, w.demo)).status,
      409,
    );
    assertEquals(
      (await call(deps, "POST", `/api/agent/proposals/${id}/reject`, w.demo)).status,
      409,
    );

    // The log now shows it as approved.
    const log = await (await call(deps, "GET", "/api/agent/runs", w.demo)).json();
    assertEquals(log.runs[0].proposals[0].status, "approved");
    assertEquals(log.pending.length, 0);
  });
});

Deno.test("rejecting a proposal records it and leaves the ledger as it was", async () => {
  await withWorld(async (w) => {
    const deps = w.deps(sensibleModel());
    const { run } = await (await call(deps, "POST", "/api/agent/run", w.demo)).json();
    const p = run.proposals[0];
    const res = await call(deps, "POST", `/api/agent/proposals/${p.id}/reject`, w.demo);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).proposal.status, "rejected");
    assertEquals(
      (await getReservation(w.kv, w.demo.ledgerId, p.reservationId))?.status,
      "to_cancel",
    );
    assertEquals((await listProposals(w.kv, w.demo.id))[0]!.status, "rejected");
  });
});

Deno.test("a proposal gone stale is not carried out: a reservation that became confirmed is never cancelled", async () => {
  await withWorld(async (w) => {
    const deps = w.deps(sensibleModel());
    const { run } = await (await call(deps, "POST", "/api/agent/run", w.demo)).json();
    const p = run.proposals[0];
    // The user changes their mind: アルバ wins the plan after all.
    const { restoreReservation, confirmReservationWithEffects } = await import(
      "../../web/store.ts"
    );
    await restoreReservation(w.kv, w.demo.ledgerId, p.reservationId, w.ids);
    await confirmReservationWithEffects(w.kv, w.demo.ledgerId, p.reservationId, w.ids, null, {
      replace: true,
    });

    const res = await call(deps, "POST", `/api/agent/proposals/${p.id}/approve`, w.demo);
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error, "stale");
    assertEquals(
      (await getReservation(w.kv, w.demo.ledgerId, p.reservationId))?.status,
      "confirmed",
    );
    assertEquals((await listProposals(w.kv, w.demo.id))[0]!.status, "stale");
  });
});

Deno.test("the model cannot propose cancelling a confirmed reservation, however it asks", async () => {
  await withWorld(async (w) => {
    const sushi = (await listReservations(w.kv, w.demo.ledgerId)).find((r) => r.service === SUSHI)!;
    const model = new ScriptedModel((req) => {
      const refused = lastToolResult(req, "propose_cancellation");
      if (refused !== null) return say("確定済みなので提案しませんでした。");
      return fcResponse({
        name: "propose_cancellation",
        args: { reservation_id: sushi.id, reason: "気分", draft_message: "キャンセルします" },
      });
    });
    const { run } = await (await call(w.deps(model), "POST", "/api/agent/run", w.demo)).json();
    assertEquals(run.proposals.length, 0);
    assertEquals(lastToolResult(model.requests[1]!, "propose_cancellation")!.ok, false);
    assertEquals(
      lastToolResult(model.requests[1]!, "propose_cancellation")!.error,
      "confirmed_reservation_cannot_be_proposed",
    );
    assertEquals((await listProposals(w.kv, w.demo.id)).length, 0);
  });
});

Deno.test("the model is not told about, and cannot reach, another user's ledger", async () => {
  await withWorld(async (w) => {
    const model = sensibleModel();
    await call(w.deps(model), "POST", "/api/agent/run", w.demo);
    const everythingSent = JSON.stringify(model.requests);
    assert(!everythingSent.includes("別人の"));

    // Asking for another user's reservation id by name finds nothing.
    const theirs = w.otherRows.find((r) => r.status === "to_cancel")!;
    const probe = new ScriptedModel((req) =>
      lastToolResult(req, "propose_cancellation") !== null ? say("終了") : fcResponse({
        name: "propose_cancellation",
        args: { reservation_id: theirs.id, reason: "x", draft_message: "y" },
      })
    );
    const { run } = await (await call(w.deps(probe), "POST", "/api/agent/run", w.demo)).json();
    assertEquals(run.proposals.length, 0);
    assertEquals(lastToolResult(probe.requests[1]!, "propose_cancellation")!.error, "not_found");
  });
});

Deno.test("POST /agent/run: 401 without the shared secret, 401 with a wrong one, nothing runs", async () => {
  await withWorld(async (w) => {
    const model = sensibleModel();
    const deps = w.deps(model);
    assertEquals((await call(deps, "POST", "/agent/run")).status, 401);
    assertEquals(
      (await call(deps, "POST", "/agent/run", undefined, { "x-plancel-agent-token": "nope" }))
        .status,
      401,
    );
    assertEquals(
      (await call(deps, "POST", "/agent/run", undefined, { "x-plancel-agent-token": TOKEN + "x" }))
        .status,
      401,
    );
    // A signed-in user's cookie is not the scheduler's secret.
    assertEquals((await call(deps, "POST", "/agent/run", w.demo)).status, 401);
    assertEquals(
      (await call(deps, "GET", "/agent/run", undefined, { "x-plancel-agent-token": TOKEN })).status,
      405,
    );
    assertEquals(model.requests.length, 0);
    assertEquals((await listRuns(w.kv, w.demo.id, 5)).length, 0);

    // Not configured → the trigger is off, not open.
    const off = w.deps(model, { agentToken: undefined });
    assertEquals(
      (await call(off, "POST", "/agent/run", undefined, { "x-plancel-agent-token": "" })).status,
      503,
    );
  });
});

Deno.test("POST /agent/run with the secret sweeps every user, each seeing only their own ledger", async () => {
  await withWorld(async (w) => {
    const model = sensibleModel();
    const deps = w.deps(model);
    const res = await call(deps, "POST", "/agent/run", undefined, {
      "x-plancel-agent-token": TOKEN,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ran, 2);

    const mine = await listProposals(w.kv, w.demo.id);
    const theirs = await listProposals(w.kv, w.other.id);
    assertEquals(mine.map((p) => p.service), [ALBA]);
    assertEquals(theirs.map((p) => p.service), ["別人の和食店"]);
    assertEquals((await listRuns(w.kv, w.demo.id, 5))[0]!.trigger, "scheduler");

    // Each user reads only their own log and cannot decide the other's proposal.
    const demoLog = await (await call(deps, "GET", "/api/agent/runs", w.demo)).json();
    const otherLog = await (await call(deps, "GET", "/api/agent/runs", w.other)).json();
    assertEquals(demoLog.pending.map((p: { service: string }) => p.service), [ALBA]);
    assertEquals(otherLog.pending.map((p: { service: string }) => p.service), ["別人の和食店"]);
    assertEquals(
      (await call(deps, "POST", `/api/agent/proposals/${theirs[0]!.id}/approve`, w.demo)).status,
      404,
    );
    // And what the model was sent for the demo user never mentioned the other's bookings.
    const sentToFirst = JSON.stringify(
      model.requests.filter((r) => JSON.stringify(r).includes(ALBA)),
    );
    assert(!sentToFirst.includes("別人の"));
  });
});

Deno.test("the scheduler leaves an unchanged ledger alone until it is stale or has changed", async () => {
  await withWorld(async (w) => {
    const model = sensibleModel();
    const deps = { kv: w.kv, clock: w.clock, ids: w.ids, transport: model };
    assertEquals((await runAgentForUser(deps, w.demo, "scheduler")).status, "ran");
    const used = model.requests.length;

    w.clock.advance("PT1H");
    assertEquals(await runAgentForUser(deps, w.demo, "scheduler"), {
      status: "skipped",
      reason: "unchanged",
    });
    assertEquals(model.requests.length, used);

    // A change in the ledger is a reason to look again.
    const { cancelReservation } = await import("../../web/store.ts");
    const hotel = (await listReservations(w.kv, w.demo.ledgerId)).find((r) =>
      r.service === "旅館 花ごろも"
    )!;
    await cancelReservation(w.kv, w.demo.ledgerId, hotel.id, w.ids);
    assertEquals((await runAgentForUser(deps, w.demo, "scheduler")).status, "ran");

    // So is the passage of time, even with nothing changed.
    const before = model.requests.length;
    w.clock.advance(`PT${UNCHANGED_RECHECK_MS / 3_600_000 + 1}H`);
    assertEquals((await runAgentForUser(deps, w.demo, "scheduler")).status, "ran");
    assert(model.requests.length > before);
    // A manual run is never skipped.
    assertEquals((await runAgentForUser(deps, w.demo, "manual")).status, "ran");
  });
});

Deno.test("the model gets at most 8 tool calls, then must report; the run still completes", async () => {
  await withWorld(async (w) => {
    const model = new ScriptedModel((req) =>
      req.toolConfig?.functionCallingConfig.mode === "NONE"
        ? say("上限に達したので、ここまでの観測を報告します。")
        : fcResponse({ name: "list_reservations", args: {} })
    );
    const { run } = await (await call(w.deps(model), "POST", "/api/agent/run", w.demo)).json();
    assertEquals(run.status, "ok");
    assertEquals(run.toolCalls, MAX_TOOL_CALLS);
    assertEquals(model.requests.length, MAX_TOOL_CALLS + 1);
    assertEquals(model.requests.at(-1)!.toolConfig?.functionCallingConfig.mode, "NONE");
    assertStringIncludes(run.summary, "報告");
  });
});

Deno.test("parallel calls in one turn are all answered, and calls past the limit are refused politely", async () => {
  await withWorld(async (w) => {
    const twelve = Array.from({ length: 12 }, () => ({ name: "list_reservations", args: {} }));
    const model = new ScriptedModel((_req, n) => n === 0 ? fcResponse(...twelve) : say("終了"));
    const { run } = await (await call(w.deps(model), "POST", "/api/agent/run", w.demo)).json();
    assertEquals(run.toolCalls, MAX_TOOL_CALLS);
    const answers = model.requests[1]!.contents.at(-1)!.parts;
    assertEquals(answers.length, 12);
    assertEquals(
      answers.filter((p) => p.functionResponse?.response.error === "tool_call_limit").length,
      4,
    );
  });
});

Deno.test("a model failure becomes an error run, releases the lock, and does not throw", async () => {
  await withWorld(async (w) => {
    const broken = {
      name: "fake",
      model: "m",
      generate: () => Promise.reject(new Error("boom: upstream 503")),
    };
    const res = await call(w.deps(broken), "POST", "/api/agent/run", w.demo);
    assertEquals(res.status, 200);
    const { run } = await res.json();
    assertEquals(run.status, "error");
    assertStringIncludes(run.error, "boom");
    // The lock is free again: the next run proceeds.
    const ok = await call(w.deps(sensibleModel()), "POST", "/api/agent/run", w.demo);
    assertEquals((await ok.json()).run.status, "ok");
  });
});

Deno.test("a run in flight blocks a second; manual runs are rate limited per user", async () => {
  await withWorld(async (w) => {
    const deps = w.deps(sensibleModel());
    assert(await acquireRunLock(w.kv, w.demo.id, "someone-else"));
    assertEquals((await call(deps, "POST", "/api/agent/run", w.demo)).status, 409);
    // The other user is unaffected by that lock.
    assertEquals((await call(deps, "POST", "/api/agent/run", w.other)).status, 200);

    const { releaseRunLock } = await import("../store.ts");
    await releaseRunLock(w.kv, w.demo.id);
    const quiet = w.deps(new ScriptedModel(() => say("対応不要")));
    let last = 0;
    for (let i = 0; i < MANUAL_RUNS_PER_HOUR + 2; i++) {
      last = (await call(quiet, "POST", "/api/agent/run", w.demo)).status;
    }
    assertEquals(last, 429);
    // The budget is per user.
    assertEquals((await call(quiet, "POST", "/api/agent/run", w.other)).status, 200);
  });
});

Deno.test("an agent without Gemini credentials says so instead of failing", async () => {
  await withWorld(async (w) => {
    const deps = w.deps(null);
    assertEquals((await call(deps, "POST", "/api/agent/run", w.demo)).status, 503);
    assertEquals(
      (await call(deps, "POST", "/agent/run", undefined, { "x-plancel-agent-token": TOKEN }))
        .status,
      503,
    );
    const log = await (await call(deps, "GET", "/api/agent/runs", w.demo)).json();
    assertEquals(log.configured, false);
    assertEquals(log.runs, []);
  });
});

Deno.test("a ledger with nothing to watch is answered without a model call; a scheduler skips it", async () => {
  await withWorld(async (w) => {
    for (const r of await listReservations(w.kv, w.demo.ledgerId)) {
      const { cancelReservation } = await import("../../web/store.ts");
      await cancelReservation(w.kv, w.demo.ledgerId, r.id, w.ids);
    }
    const model = sensibleModel();
    const deps = { kv: w.kv, clock: w.clock, ids: w.ids, transport: model };
    assertEquals(await runAgentForUser(deps, w.demo, "scheduler"), {
      status: "skipped",
      reason: "nothing_to_watch",
    });
    const manual = await runAgentForUser(deps, w.demo, "manual");
    assertEquals(manual.status, "ran");
    assertEquals(model.requests.length, 0);
  });
});

Deno.test("notifications are logged once, not repeated by the next run", async () => {
  await withWorld(async (w) => {
    const hotels = (await listReservations(w.kv, w.demo.ledgerId)).filter((r) =>
      r.plan === "京都旅行（宿）"
    );
    const model = new ScriptedModel((req) =>
      lastToolResult(req, "notify_user") !== null ? say("通知しました。") : fcResponse({
        name: "notify_user",
        args: {
          title: "京都の宿を決めてください",
          body: "無料期限は明日までです。",
          level: "warning",
          reservation_ids: hotels.map((h) => h.id),
        },
      })
    );
    const deps = { kv: w.kv, clock: w.clock, ids: w.ids, transport: model };
    const first = await runAgentForUser(deps, w.demo, "manual");
    const second = await runAgentForUser(deps, w.demo, "manual");
    assert(first.status === "ran" && second.status === "ran");
    assertEquals(first.run.notifications.length, 1);
    assertEquals(second.run.notifications.length, 0);
    assertEquals(lastToolResult(model.requests.at(-1)!, "notify_user")!.duplicate, true);
  });
});

Deno.test("an already-pending proposal is not proposed twice across runs", async () => {
  await withWorld(async (w) => {
    const deps = w.deps(sensibleModel());
    await call(deps, "POST", "/api/agent/run", w.demo);
    await call(deps, "POST", "/api/agent/run", w.demo);
    assertEquals((await listProposals(w.kv, w.demo.id)).length, 1);
  });
});

Deno.test("deleting an account removes its agent history", async () => {
  await withWorld(async (w) => {
    await call(w.deps(sensibleModel()), "POST", "/api/agent/run", w.demo);
    assertEquals((await listRuns(w.kv, w.demo.id, 5)).length, 1);
    await deleteAccount(w.kv, w.demo.id, w.ids);
    assertEquals((await listRuns(w.kv, w.demo.id, 5)).length, 0);
    assertEquals((await listProposals(w.kv, w.demo.id)).length, 0);
  });
});

Deno.test("tokenMatches: equal secrets match, anything else does not (including length differences)", async () => {
  assertEquals(await tokenMatches("abc", "abc"), true);
  assertEquals(await tokenMatches("abd", "abc"), false);
  assertEquals(await tokenMatches("abcd", "abc"), false);
  assertEquals(await tokenMatches("", "abc"), false);
  assertEquals(await tokenMatches(null, "abc"), false);
});

Deno.test("a provider quota or overload is reported in words, not as the provider's JSON", async () => {
  await withWorld(async (w) => {
    const failing = (status: number) => ({
      name: "gemini-api",
      model: "m",
      generate: () =>
        Promise.reject(new GeminiTransportError("gemini-api", status, '{"error":{"code":429}}')),
    });
    const quota = await (await call(w.deps(failing(429)), "POST", "/api/agent/run", w.demo)).json();
    assertEquals(quota.run.status, "error");
    assertStringIncludes(quota.run.error, "利用上限");
    assert(!quota.run.error.includes("{"));
    const busy = await (await call(w.deps(failing(503)), "POST", "/api/agent/run", w.demo)).json();
    assertStringIncludes(busy.run.error, "混み合って");
  });
});
