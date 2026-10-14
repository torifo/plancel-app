/** What cancelling costs now versus after the next fee boundary, computed with the ledger's own policy math. */
import { jst } from "../mcp/web_api_view.ts";
import { boundaryMs, describePolicy, freeDeadlineMs, pctAt, stagesOf } from "../web/policy.ts";
import { toInstantOrNull } from "../web/instant.ts";
import type { WebReservation } from "../web/store.ts";

const HOUR_MS = 3_600_000;

/** An epoch-ms instant in the +09:00 form the model reads everywhere else. */
export const jstOfEpoch = (ms: number): string =>
  jst(Temporal.Instant.fromEpochMilliseconds(ms).toString());

export interface LossEstimate {
  id: string;
  service: string;
  amount: number | null;
  policyText: string;
  /** False when the policy (or the start) is unreadable: no loss can be computed. */
  policyKnown: boolean;
  /** Fee if cancelled at the moment of the estimate. */
  now: { pct: number | null; yen: number | null };
  /** The next time the rate rises, and what cancelling just after it costs. */
  next: {
    at: string;
    hoursFromNow: number;
    pct: number;
    yen: number | null;
    extraYen: number | null;
  } | null;
  /** End of the free-cancellation window (+09:00), or null when there is none to watch. */
  freeUntil: string | null;
  note: string | null;
}

const yenOf = (amount: number | null, pct: number | null): number | null =>
  amount === null || pct === null ? null : Math.round(amount * pct / 100);

export function estimateLoss(r: WebReservation, nowMs: number): LossEstimate {
  const base = {
    id: r.id,
    service: r.service,
    amount: r.amount,
    policyText: describePolicy(r.policy),
  };
  const stages = stagesOf(r.policy);
  const start = toInstantOrNull(r.startsAt)?.epochMilliseconds ?? null;
  if (stages === null || start === null) {
    return {
      ...base,
      policyKnown: false,
      now: { pct: null, yen: null },
      next: null,
      freeUntil: null,
      note: stages === null
        ? "キャンセル規定が不明なため、損失は計算できません。"
        : "開始日時が読み取れないため、損失は計算できません。",
    };
  }

  const pct = pctAt(r.policy, start, nowMs);
  const deadline = freeDeadlineMs(r.policy, r.startsAt);
  // Stages descend, so the first boundary still ahead ends the rate in force and
  // the stage after it is the rate that follows.
  const i = stages.findIndex((s) => nowMs <= boundaryMs(start, s.h));
  const following = i < 0 ? undefined : stages[i + 1];
  const boundary = i < 0 ? 0 : boundaryMs(start, stages[i]!.h);
  const nowYen = yenOf(r.amount, pct);
  const nextYen = following === undefined ? null : yenOf(r.amount, following.pct);
  return {
    ...base,
    policyKnown: true,
    now: { pct, yen: nowYen },
    next: following === undefined ? null : {
      at: jstOfEpoch(boundary),
      hoursFromNow: Math.round(((boundary - nowMs) / HOUR_MS) * 10) / 10,
      pct: following.pct,
      yen: nextYen,
      extraYen: nextYen === null || nowYen === null ? null : nextYen - nowYen,
    },
    freeUntil: deadline === null ? null : jstOfEpoch(deadline),
    note: r.amount === null ? "金額が未入力のため、円での損失は出せません（料率のみ）。" : null,
  };
}
