// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The credit engine (task #11) — the only module that writes a lot's
 * lifecycle, its designation, or what is left on it.
 *
 * Everything else reads. Concentrating the writes here is what makes the
 * invariants checkable: a lot's remaining balance must always equal the
 * ledger summed over that lot, and every path that changes one writes the
 * other in the same transaction.
 *
 * Which pool pays is decided by the project, not by the person: the bytes
 * land in a project, so the studio that owns the project pays. A studio's
 * guest who is an editor on one of its projects generates there and spends
 * that studio's credits — which is the whole point of a shared pool, and the
 * reason the payer and the actor are recorded separately.
 *
 * This module never logs — libraries here do not. A charge that could not be
 * fully covered says so in what it returns, and the caller, which knows the
 * task and the user, writes the reconciliation line.
 */

import * as creditLotRepo from "@domain/credit/creditLot.repo.js";
import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";
import {
  toMicroCredits,
  fromMicroCredits,
  planCharge,
} from "@domain/credit/credit-math.js";
import {
  db,
  env,
  getRedis,
  AppError,
  NotFoundError,
  ForbiddenError,
} from "@breatic/core";
import { t } from "@breatic/shared";
import type { CreditLotEntity } from "@breatic/shared";

/**
 * The shape a caller-supplied idempotency key must take: ASCII alphanumerics
 * plus `_`, `:`, `.` and `-`, 1 to 255 long. Checked at entry so a malformed
 * key cannot collide with another by collapsing to the same lock key.
 */
export const REFKEY_PATTERN = /^[A-Za-z0-9_:.-]{1,255}$/;

/** How long a billed key stays claimed. */
const BILL_LOCK_TTL_SECONDS = 86_400;

/** Lifecycles in which a lot is on its way out of the account. */
const REFUND_LIFECYCLES: ReadonlySet<string> = new Set([
  "refund_pending",
  "refunding",
  "refunded",
]);

/** What one generation wants charged. */
export interface ChargeInput {
  /**
   * Where the bytes landed, which is what decides who pays. Null only for the
   * text tools, whose route carries no project yet (#122) — usage is then
   * recorded against nobody's purchase.
   */
  projectId: string | null;
  /** Who ran the generation. Recorded as the actor, and as the payer when there is no lot. */
  actorUserId: string;
  /** How many credits it cost. */
  amount: number;
  description?: string;
  /** Task or idempotency key. Every row of one charge shares it. */
  referenceId?: string;
  tokensUsed?: number;
  model?: string;
  provider?: string;
}

/** What actually happened to a charge. */
export interface ChargeOutcome {
  /** Whether any credits were taken. False when payments are off, or nothing could be charged. */
  billed: boolean;
  /** Credits actually taken. */
  charged: number;
  /**
   * Credits that could not be taken. Above zero means the account is short
   * and the caller should log it for reconciliation — the task is not failed
   * and nothing is rolled back: the user already has their result.
   */
  shortfall: number;
  /** The studio that paid, when one could be resolved. */
  studioId: string | null;
  /** The lots drawn down, oldest first. */
  lotIds: readonly string[];
}

/**
 * Open a lot for a payment that has completed, with its opening ledger row.
 *
 * Both writes go in one transaction because the lot's remaining balance is
 * defined as the ledger summed over it: a lot without its `topup` row would
 * read as owing its whole value.
 *
 * The lot is born unassigned, so the credits are not spendable until someone
 * designates them. That is a deliberate consequence of "unassigned cannot be
 * spent" and the interface has to say so: a buyer told only that assigning is
 * available will assume the credits already work.
 * @param input - The completed payment.
 * @param input.paymentId - The payment row. Unique across lots, so a redelivered webhook fails here.
 * @param input.userId - Who paid.
 * @param input.purchasedCredits - How many credits it bought.
 * @returns The new lot.
 * @throws {Error} If a lot already exists for this payment — the unique constraint rejects the insert.
 */
export async function grantFromPayment(input: {
  paymentId: string;
  userId: string;
  purchasedCredits: number;
}): Promise<CreditLotEntity> {
  const amount = fromMicroCredits(toMicroCredits(input.purchasedCredits));
  return db.transaction(async (tx) => {
    const lot = await creditLotRepo.createLot(
      {
        paymentId: input.paymentId,
        userId: input.userId,
        purchasedCredits: amount,
      },
      tx,
    );
    await creditLotRepo.appendLedgerEntry(
      {
        payerUserId: input.userId,
        entryType: "topup",
        amount,
        lotId: lot.id,
        referenceId: input.paymentId,
      },
      tx,
    );
    return lot;
  });
}

/**
 * Charge one generation to the studio that owns its project.
 *
 * Runs after the work was delivered, so it never fails the caller and never
 * rolls anything back. What it cannot cover it reports; what it can cover it
 * takes, lot by lot, oldest first.
 *
 * Locking is the part worth reading twice. Candidates are chosen without
 * locks, then locked one at a time in that same order — a fixed order, so two
 * concurrent charges on one studio queue up instead of each holding half of
 * what the other needs and deadlocking. Each lock is taken on the primary key
 * alone and everything that decides eligibility is re-read afterwards:
 * Postgres re-evaluates a `FOR UPDATE` predicate once the lock is granted and
 * skips rows that no longer match, so a predicate mentioning `lifecycle` or
 * `designated_studio_id` would come back empty exactly when a concurrent
 * writer had touched the row. Re-checking the designation matters on its own:
 * without it, a lot reassigned between being chosen and being locked would
 * still be charged to the studio that just lost it.
 *
 * Only as many lots are locked as the charge needs.
 * @param input - What to charge and on whose behalf.
 * @returns What was taken, what was not, and from where.
 */
export async function chargeForGeneration(
  input: ChargeInput,
): Promise<ChargeOutcome> {
  const amountMicro = toMicroCredits(input.amount);
  const studioId = input.projectId
    ? await resolveOwnerStudioId(input.projectId)
    : null;

  const usageEntry = {
    payerUserId: input.actorUserId,
    actorUserId: input.actorUserId,
    entryType: "spend" as const,
    studioId,
    projectId: input.projectId,
    model: input.model,
    provider: input.provider,
    tokensUsed: input.tokensUsed,
    description: input.description,
    referenceId: input.referenceId,
  };

  // Payments off — every local install and every self-hosted one. Usage is
  // still recorded, because a deployment that charges nobody still wants to
  // know what it produced; there is simply no purchase to draw it from.
  if (!env.PAYMENT_ENABLED) {
    await creditLotRepo.appendLedgerEntry({
      ...usageEntry,
      amount: fromMicroCredits(-amountMicro),
      lotId: null,
    });
    return { billed: false, charged: 0, shortfall: 0, studioId, lotIds: [] };
  }

  // No project means no studio and therefore no pool. Today only the text
  // tools reach here (#122): their route never took a project id, which is a
  // gap in the product rather than a decision. Recording the usage keeps the
  // account honest; the shortfall tells the caller to log it.
  if (studioId === null) {
    await creditLotRepo.appendLedgerEntry({
      ...usageEntry,
      amount: fromMicroCredits(-amountMicro),
      lotId: null,
    });
    return {
      billed: false,
      charged: 0,
      shortfall: amountMicro / 1_000_000,
      studioId: null,
      lotIds: [],
    };
  }

  return db.transaction(async (tx) => {
    const candidates = await creditLotRepo.listSpendableLots(studioId, tx);

    const locked: { id: string; remaining: number }[] = [];
    let available = 0;
    for (const candidate of candidates) {
      if (available >= amountMicro) break;
      const row = await creditLotRepo.lockLot(candidate.id, tx);
      if (!row) continue;
      if (row.lifecycle !== "active") continue;
      if (row.designatedStudioId !== studioId) continue;
      const remaining = toMicroCredits(row.remainingCredits);
      if (remaining <= 0) continue;
      locked.push({ id: row.id, remaining });
      available += remaining;
    }

    const plan = planCharge(locked, amountMicro);

    // Nothing could be taken: the studio holds no spendable lot, or the ones
    // it held were reassigned or refunded while the task ran. The usage is
    // recorded against the person with no lot behind it, the same shape a
    // payments-off install writes — without it this generation leaves no
    // trace at all, and the account shows work that never happened.
    //
    // A partial charge writes no such row: its allocations already record the
    // generation under one reference id, and a second row for the uncovered
    // part would double it in any sum over that id. What went uncharged there
    // reaches the caller as `shortfall`.
    if (plan.allocations.length === 0) {
      await creditLotRepo.appendLedgerEntry(
        {
          ...usageEntry,
          amount: fromMicroCredits(-amountMicro),
          lotId: null,
        },
        tx,
      );
      return {
        billed: false,
        charged: 0,
        shortfall: amountMicro / 1_000_000,
        studioId,
        lotIds: [],
      };
    }

    for (const allocation of plan.allocations) {
      await creditLotRepo.applyCharge(
        allocation.lotId,
        fromMicroCredits(allocation.amount),
        tx,
      );
      await creditLotRepo.appendLedgerEntry(
        {
          ...usageEntry,
          payerUserId: candidates.find((lot) => lot.id === allocation.lotId)!.userId,
          amount: fromMicroCredits(-allocation.amount),
          lotId: allocation.lotId,
        },
        tx,
      );
    }

    const charged = amountMicro - plan.shortfall;
    return {
      billed: charged > 0,
      charged: charged / 1_000_000,
      shortfall: plan.shortfall / 1_000_000,
      studioId,
      lotIds: plan.allocations.map((allocation) => allocation.lotId),
    };
  });
}

/**
 * Charge a generation at most once for a given key.
 *
 * A chat turn and a text-tool run can both arrive twice — a reconnect, a
 * replayed stream — and the caller-supplied key is what makes the second
 * arrival free. The lock sits outside the cross-lot logic, so a key that has
 * already been billed never reaches it.
 *
 * The key is scoped by the acting user, matching how Stripe, Square, AWS and
 * PayPal scope idempotency keys: two accounts whose keys collide never
 * interfere, so nobody can skip their own charge by reusing somebody else's
 * key. On failure the lock is released, leaving a retry able to charge.
 * @param refKey - The caller's idempotency key.
 * @param input - What to charge and on whose behalf.
 * @returns The outcome on the first call, or null when this key was already billed.
 * @throws {Error} If `refKey` does not match {@link REFKEY_PATTERN} — a caller
 *   of ours built it, so this reaches the handler's 500 branch and is logged.
 */
export async function chargeOnceForGeneration(
  refKey: string,
  input: ChargeInput,
): Promise<ChargeOutcome | null> {
  if (!REFKEY_PATTERN.test(refKey)) {
    throw new Error(
      `chargeOnceForGeneration: refKey must match ${REFKEY_PATTERN} (got ${JSON.stringify(refKey)})`,
    );
  }

  const redis = getRedis();
  const lockKey = `${env.ENV}:bill:${input.actorUserId}:${refKey}`;
  const acquired = await redis.set(lockKey, "1", "EX", BILL_LOCK_TTL_SECONDS, "NX");
  if (acquired !== "OK") return null;

  try {
    return await chargeForGeneration({ ...input, referenceId: refKey });
  } catch (err) {
    await redis.del(lockKey);
    throw err;
  }
}

/**
 * Point a lot at a studio, or take it back to unassigned.
 *
 * Only the buyer may move their own purchase, and only onto a studio they
 * administer — designating credits somewhere is deciding who gets to spend
 * them. A lot that belongs to somebody else answers 404 rather than 403, so
 * the endpoint does not confirm which lot ids exist.
 *
 * A lot in the refund flow refuses to move. Not because it would change the
 * refund — that is computed from what remains, which this does not touch —
 * but because the lot is on its way out of the account, and letting it move
 * between studios in the meantime makes "what can this studio spend" jump
 * around for a balance that is about to be zero.
 *
 * Submitting the designation a lot already has succeeds and changes nothing,
 * including `null` on an unassigned lot: the operation is idempotent, and a
 * retry after a lost response must not read as a conflict.
 * @param input - Which lot, on whose behalf, and where to.
 * @param input.lotId - The lot to designate.
 * @param input.requestingUserId - Who is asking. Must be the buyer.
 * @param input.studioId - The studio to point it at, or null to unassign.
 * @returns The lot as it now stands.
 * @throws {NotFoundError} If the lot does not exist or belongs to someone else.
 * @throws {ForbiddenError} If the caller does not administer the target studio.
 * @throws {AppError} 409 if the lot is in the refund flow.
 */
export async function designateLot(input: {
  lotId: string;
  requestingUserId: string;
  studioId: string | null;
}): Promise<CreditLotEntity> {
  if (input.studioId !== null) {
    const role = await studioMembersRepo.getRole(
      input.studioId,
      input.requestingUserId,
    );
    if (role !== "admin") {
      throw new ForbiddenError(t("server.credit.not_studio_admin"));
    }
  }

  return db.transaction(async (tx) => {
    const lot = await creditLotRepo.lockLot(input.lotId, tx);
    if (!lot || lot.userId !== input.requestingUserId) {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (REFUND_LIFECYCLES.has(lot.lifecycle)) {
      throw new AppError(409, t("server.credit.designation_locked"));
    }
    if (lot.designatedStudioId === input.studioId) return lot;
    return creditLotRepo.setDesignation(input.lotId, input.studioId, tx);
  });
}

/**
 * What a studio can spend right now.
 * @param studioId - The studio to total.
 * @returns The total in credits.
 */
export async function getSpendableCredits(studioId: string): Promise<number> {
  return toMicroCredits(await creditLotRepo.sumSpendableForStudio(studioId)) / 1_000_000;
}

/**
 * What an account holds that no studio can spend yet.
 * @param userId - The account to total.
 * @returns The total in credits.
 */
export async function getUnassignedCredits(userId: string): Promise<number> {
  return toMicroCredits(await creditLotRepo.sumUnassignedForUser(userId)) / 1_000_000;
}
