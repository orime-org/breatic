// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Credit holds (inner#1611): what a studio has promised to work that is
 * running and not yet charged.
 *
 * An admission that only reads the balance lets every concurrent request see
 * the same credits and pass, and the charges that follow push the studio into
 * debt. Here an admission counts what the designated lots hold, less the debt, less
 * every hold still counted, and writes its own hold before letting the work
 * start. Admissions and charges on one studio both take the studio's debt
 * lock first, so they queue and each sees what the one before it held.
 *
 * Holds exist only while payments are on; with payments off every admission
 * passes and nothing is written, as before.
 */

import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import * as creditLotRepo from "@domain/credit/creditLot.repo.js";
import * as spendLimitRepo from "@domain/credit/spendLimit.repo.js";
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";
import { fromMicroCredits, positionFrom, serializeCreditPosition, toChargeMicro, toMicroCredits, type CreditPositionMicro } from "@domain/credit/credit-math.js";
import { db, env } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { parseCreditDecimal, quantizeQuotedCredits, type CreditDecimal, type ProjectCreditsView } from "@breatic/shared";
import { getSpendableCredits } from "@domain/credit/creditLot.service.js";

/** One hold asked for. */
export interface HoldRequest {
  /** The project the work runs in; its studio's credits are held. */
  projectId: string;
  /** Who started the work. */
  actorUserId: string;
  /** The run's task id. Used once. */
  referenceId: string;
  /** Credits to hold. */
  amount: number;
  /** How long the hold counts if nothing releases it. */
  ttlMs: number;
}

/** A monthly spend limit an admission would pass (inner#1968, design 3.10). */
export interface SpendCapHit {
  /** The person's own limit, or the studio's total. */
  scope: "member" | "studio";
  /** The limit, as a decimal string. */
  limit: string;
  /** The next UTC month's first instant, as ISO text. */
  resetsAt: string;
}

/** What an admission came to: admitted, refused by a spend limit, or refused with the studio's position. */
export type ReserveOutcome =
  | { ok: true }
  | { ok: false; cap: SpendCapHit }
  | ({ ok: false; studioId: string; cap?: undefined } & ProjectCreditsView);

/**
 * The UTC calendar month an instant falls in.
 * @param at - The instant.
 * @returns Its first instant and the next month's.
 */
function utcMonthOf(at: Date): { start: Date; next: Date } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    next: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

/** What a studio spent this UTC month, in millionths: in total and per person. */
export interface MonthSpent {
  month: { start: Date; next: Date };
  total: bigint;
  byActor: Map<string, bigint>;
}

/**
 * What a studio spent this UTC month: every charge request filed against it
 * this month, pending or settled, plus every counted hold no pending request
 * has taken over (design 3.10).
 * @param studioId - The studio.
 * @param tx - Optional transaction, so an admission sums under its lock.
 * @returns The month, the total and each person's part.
 */
export async function monthSpent(studioId: string, tx?: DbTx): Promise<MonthSpent> {
  const month = utcMonthOf(new Date());
  const byActor = new Map<string, bigint>();
  let total = 0n;
  for (const { actorUserId, amount } of await creditHoldRepo.sumSpentByActor(studioId, month.start, month.next, tx)) {
    const micro = toMicroCredits(amount);
    byActor.set(actorUserId, (byActor.get(actorUserId) ?? 0n) + micro);
    total += micro;
  }
  return { month, total, byActor };
}

/**
 * The monthly limit that applies to one person: their own when an admin set
 * one (which may be no limit at all), otherwise the studio's per-person default.
 * @param limits - The studio's limits.
 * @param limits.memberDefault - The per-person default; null when unset.
 * @param override - The person's own limit, if an admin set one.
 * @param override.monthlyCredits - Its amount; null for no limit.
 * @returns The amount, or null when no limit applies.
 */
export function effectiveMemberLimit(limits: { memberDefault: string | null }, override: { monthlyCredits: string | null } | null): string | null {
  return override === null ? limits.memberDefault : override.monthlyCredits;
}

/**
 * The limit an admission would pass. With an estimate, spent plus the estimate
 * must stay within each limit, judged under the studio's debt lock the caller
 * holds, since the admission then writes its hold; without one (work admitted
 * on a balance above zero, which writes nothing), spent must be below it, read
 * once. The studio's total is named when both are passed: raising one
 * person's limit would not let it through.
 * @param studioId - The studio.
 * @param actorUserId - Who starts the work.
 * @param estimate - What it will hold, in millionths; null when it holds nothing.
 * @param tx - The admission's transaction, when it holds the lock.
 * @returns The limit passed, or null when the work fits.
 */
async function spendCapHit(studioId: string, actorUserId: string, estimate: bigint | null, tx?: DbTx): Promise<SpendCapHit | null> {
  const limits = await spendLimitRepo.getStudioLimits(studioId, tx);
  const memberLimit = effectiveMemberLimit(limits, await spendLimitRepo.findOverride(studioId, actorUserId, tx));
  if (memberLimit === null && limits.studioMonthly === null) return null;
  const spent = await monthSpent(studioId, tx);
  /**
   * Whether spending this far passes a limit.
   * @param already - What is spent.
   * @param limit - The limit.
   * @returns True when the work does not fit.
   */
  const passes = (already: bigint, limit: string): boolean => {
    const cap = toMicroCredits(limit);
    return estimate === null ? already >= cap : already + estimate > cap;
  };
  const resetsAt = spent.month.next.toISOString();
  if (limits.studioMonthly !== null && passes(spent.total, limits.studioMonthly)) {
    return { scope: "studio", limit: fromMicroCredits(toMicroCredits(limits.studioMonthly)), resetsAt };
  }
  if (memberLimit !== null && passes(spent.byActor.get(actorUserId) ?? 0n, memberLimit)) {
    return { scope: "member", limit: fromMicroCredits(toMicroCredits(memberLimit)), resetsAt };
  }
  return null;
}

/** Why work admitted on a balance above zero may not start. */
export type BalanceRefusal =
  | { reason: "spend_cap"; cap: SpendCapHit }
  | { reason: "no_credits"; studioId: string; spendable: CreditDecimal };

/**
 * The one admission of work that holds nothing (chat turns, text tools,
 * Timeline executions): the spend limits first, as every admission judges them
 * (design 3.10), passing while spent is below each limit, then a balance that
 * reaches `required`. It writes nothing, so it reads the limits, this month's
 * spending and the balance once, with no lock.
 * @param projectId - The project the work belongs to; its studio pays.
 * @param actorUserId - Who starts it.
 * @param required - Credits the studio's balance must at least reach.
 * @returns Why it may not start, or null when it may; null with payments off.
 * @throws {NotFoundError} When the project has no live studio.
 */
export async function judgeBalanceAdmission(projectId: string, actorUserId: string, required: number): Promise<BalanceRefusal | null> {
  if (!env.PAYMENT_ENABLED) return null;
  const studioId = await resolveOwnerStudioId(projectId);
  const cap = await spendCapHit(studioId, actorUserId, null);
  if (cap !== null) return { reason: "spend_cap", cap };
  const spendable = await getSpendableCredits(studioId);
  return parseCreditDecimal(spendable) >= quantizeQuotedCredits(required) ? null : { reason: "no_credits", studioId, spendable };
}

/**
 * Take the studio's debt lock and read its position under it.
 * @param studioId - The studio.
 * @param tx - The transaction that takes and keeps the lock.
 * @returns Its balance, counted holds and what is left.
 */
async function lockedPosition(studioId: string, tx: DbTx): Promise<CreditPositionMicro> {
  const debt = await creditLotRepo.lockDebt(studioId, tx);
  const lots = await creditLotRepo.sumSpendableForStudio(studioId, tx);
  const held = await creditHoldRepo.sumHeldForStudio(studioId, tx);
  return positionFrom(lots, debt, held);
}

/**
 * When a hold of this length stops counting.
 * @param ttlMs - Its length.
 * @returns The instant.
 */
function expiryFor(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}

/**
 * Admit a piece of work and hold its estimate, or refuse it.
 * @param request - What to hold, for whom and for how long.
 * @param outer - The caller's transaction, when the hold must commit or roll back with the row it admits (a mini-tool run
 *   whose task id the client chose holds in the transaction that claims that id); a refusal writes nothing in it.
 * @returns Admitted, or the figures the refusal is explained with.
 * @throws {Error} When the key already has a hold, held or released.
 * @throws {NotFoundError} When the project has no live studio.
 */
export async function reserveCredits(request: HoldRequest, outer?: DbTx): Promise<ReserveOutcome> {
  if (!env.PAYMENT_ENABLED) return { ok: true };
  const studioId = await resolveOwnerStudioId(request.projectId, outer);
  const amount = toChargeMicro(request.amount);
  /**
   * Judge and hold under the studio's debt lock.
   * @param tx - The transaction holding that lock.
   * @returns The outcome.
   */
  const hold = async (tx: DbTx): Promise<ReserveOutcome> => {
    const position = await lockedPosition(studioId, tx);
    const cap = await spendCapHit(studioId, request.actorUserId, amount, tx);
    if (cap !== null) return { ok: false, cap };
    if (position.available < amount) return { ok: false, studioId, ...serializeCreditPosition(position) };
    await creditHoldRepo.insertHold(
      {
        studioId,
        actorUserId: request.actorUserId,
        referenceId: request.referenceId,
        amount: fromMicroCredits(amount),
        expiresAt: expiryFor(request.ttlMs),
      },
      tx,
    );
    return { ok: true };
  };
  return outer === undefined ? db.transaction(hold) : hold(outer);
}

/**
 * Release a hold. Releasing one that is gone or already released does nothing.
 * @param referenceId - Its key.
 * @throws {Error} When the database fails.
 */
export async function releaseHold(referenceId: string): Promise<void> {
  await creditHoldRepo.releaseHold(referenceId);
}

/**
 * Keep a task's hold alive while its cost is looked up after delivery (inner#1743): moved to a later expiry, never an
 * earlier one; a released hold stays released.
 * @param referenceId - Its key, the task id.
 * @param until - The new expiry.
 * @throws {Error} When the database fails.
 */
export async function extendHold(referenceId: string, until: Date): Promise<void> {
  await creditHoldRepo.extendHold(referenceId, until);
}

/**
 * A Studio's designated lot balance less debt, its counted holds, and what is left, as of
 * one instant.
 * @param studioId - The studio.
 * @returns The three figures, in credits.
 */
export async function getCreditPosition(studioId: string): Promise<ProjectCreditsView> {
  return db.transaction(
    async (tx) => {
      const [lots, debt, held] = await Promise.all([
        creditLotRepo.sumSpendableForStudio(studioId, tx),
        creditLotRepo.readDebt(studioId, tx),
        creditHoldRepo.sumHeldForStudio(studioId, tx),
      ]);
      return serializeCreditPosition(positionFrom(lots, debt, held));
    },
    { isolationLevel: "repeatable read" },
  );
}
