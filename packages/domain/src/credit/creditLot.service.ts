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
import type {
  CreditLotEntity,
  CreditOverview,
  StudioCreditSummary,
} from "@breatic/shared";

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
 * alone, and the three things a concurrent writer can change are re-read once
 * it is held: the lifecycle, the designation, and what is left. The key alone
 * is what the lock can name, because Postgres re-evaluates a `FOR UPDATE`
 * predicate once the lock is granted and skips rows that no longer match — a
 * predicate mentioning `lifecycle` or `designated_studio_id` would come back
 * empty exactly when a concurrent writer had touched the row. Re-checking the
 * designation matters on its own: without it, a lot reassigned between being
 * chosen and being locked would still be charged to the studio that just lost
 * it.
 *
 * Only as many lots are locked as the charge needs.
 * @param input - What to charge and on whose behalf.
 * @returns What was taken, what was not, and from where.
 */
export async function chargeForGeneration(
  input: ChargeInput,
): Promise<ChargeOutcome> {
  const amountMicro = toMicroCredits(input.amount);
  // A project that vanished while the task ran leaves nothing to charge, and
  // the usage still has to be recorded: the work was delivered. That is the one
  // thing `lot_id` was made nullable for.
  //
  // Only that one cause is absorbed. Any other failure — the connection went,
  // the pool ran dry — leaves this code knowing nothing, and a row saying the
  // studio had nothing to draw from would turn an unknown failure into a
  // settled fact that the caller reads as a normal outcome and logs as a
  // shortfall.
  const studioId = input.projectId
    ? await resolveOwnerStudioId(input.projectId).catch((err: unknown) => {
        if (err instanceof NotFoundError) return null;
        throw err;
      })
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

  // No studio means no pool. Two ways to get here: the text tools, whose route
  // never took a project id (#122, a gap in the product rather than a
  // decision), and a project deleted while its task was still running.
  // Recording the usage keeps the account honest; the shortfall tells the
  // caller to log it.
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
    // The debt row first, and before any lot. Both writers take it in this
    // order, so two charges on one studio — or a charge and a designation —
    // queue up rather than each holding half of what the other needs.
    await creditLotRepo.lockDebt(studioId, tx);
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

    // What the lots could not cover becomes what this studio owes. One row,
    // whether the charge took part of the bill or none of it: both are the
    // same event seen from the pool, and it carries the full context because
    // a charge that took nothing wrote no `spend` row to carry it — the
    // project and the model on the credits page come from here.
    if (plan.shortfall > 0) {
      await creditLotRepo.adjustDebt(
        studioId,
        fromMicroCredits(plan.shortfall),
        tx,
      );
      await creditLotRepo.appendLedgerEntry(
        {
          ...usageEntry,
          entryType: "debt_incurred",
          amount: fromMicroCredits(-plan.shortfall),
          lotId: null,
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
 * A lot in the refund flow refuses to move, because it is on its way out of
 * the account: asking for a refund detaches the lot from its studio then and
 * there, and until the refund resolves the money belongs to no pool and may
 * not be put back to work. A rejection returns it to `active`, still
 * unassigned, and only then may it be designated again.
 *
 * Designating into a studio that owes credits pays the debt down first, out
 * of this lot, before any of it becomes spendable. That is what makes the
 * debt collectable at all: a studio that owes has nothing left to charge, so
 * the only moment credits and a debt meet is this one.
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
    // The debt row before the lot, the same order a charge takes them in, so
    // the two queue up rather than deadlocking against each other.
    const owedMicro =
      input.studioId === null
        ? 0
        : toMicroCredits(await creditLotRepo.lockDebt(input.studioId, tx));

    const lot = await creditLotRepo.lockLot(input.lotId, tx);
    if (!lot || lot.userId !== input.requestingUserId) {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (REFUND_LIFECYCLES.has(lot.lifecycle)) {
      throw new AppError(409, t("server.credit.designation_locked"));
    }
    if (lot.designatedStudioId === input.studioId) return lot;
    const designated = await creditLotRepo.setDesignation(
      input.lotId,
      input.studioId,
      tx,
    );

    if (input.studioId === null || owedMicro <= 0) return designated;

    const repaidMicro = Math.min(
      owedMicro,
      toMicroCredits(designated.remainingCredits),
    );
    if (repaidMicro <= 0) return designated;

    const repaid = fromMicroCredits(repaidMicro);
    const charged = await creditLotRepo.applyCharge(input.lotId, repaid, tx);
    await creditLotRepo.adjustDebt(input.studioId, `-${repaid}`, tx);
    await creditLotRepo.appendLedgerEntry(
      {
        payerUserId: designated.userId,
        actorUserId: input.requestingUserId,
        entryType: "debt_repayment",
        studioId: input.studioId,
        amount: fromMicroCredits(-repaidMicro),
        lotId: input.lotId,
      },
      tx,
    );
    return {
      ...designated,
      remainingCredits: charged.remainingCredits,
      lifecycle: charged.lifecycle,
    };
  });
}

/**
 * What an account holds and where it went.
 *
 * A studio appears here if it holds credits of this account's or has spent
 * some, which are different sets: a studio that spent its last credit still
 * belongs on the panel, and one that was just assigned its first has nothing
 * spent yet.
 * @param userId - The account to summarise.
 * @returns The overview.
 */
export async function getOverview(userId: string): Promise<CreditOverview> {
  const [spendableRows, spentRows, unassigned] = await Promise.all([
    creditLotRepo.sumSpendableByStudio(userId),
    creditLotRepo.sumSpentByStudio(userId),
    getUnassignedCredits(userId),
  ]);

  const byStudio = new Map<string, StudioCreditSummary>();
  for (const row of spendableRows) {
    byStudio.set(row.studioId, {
      studioId: row.studioId,
      studioName: row.studioName,
      studioSlug: row.studioSlug,
      deleted: false,
      spendable: toMicroCredits(row.spendable) / 1_000_000,
      debt: 0,
      spent: 0,
      lotCount: row.lotCount,
    });
  }
  for (const row of spentRows) {
    const existing = byStudio.get(row.studioId);
    const spent = toMicroCredits(row.spent) / 1_000_000;
    if (existing) existing.spent = spent;
    // Only the spending side reaches a deleted studio: the spendable side
    // excludes them, so a studio that appears here alone is one that is gone.
    else
      byStudio.set(row.studioId, {
        studioId: row.studioId,
        studioName: row.studioName,
        studioSlug: row.studioSlug,
        deleted: true,
        spendable: 0,
        debt: 0,
        spent,
        lotCount: 0,
      });
  }

  const studios = [...byStudio.values()];
  const debts = await creditLotRepo.readDebtsFor(studios.map((s) => s.studioId));
  for (const studio of studios) {
    studio.debt = toMicroCredits(debts.get(studio.studioId) ?? "0") / 1_000_000;
  }

  return {
    assignedCredits: studios.reduce((sum, s) => sum + s.spendable, 0),
    unassignedCredits: unassigned,
    billing: env.PAYMENT_ENABLED,
    studios,
  };
}

/**
 * What a studio can spend right now, which is negative when it owes.
 *
 * One number rather than a balance and a debt beside it: two numbers about
 * the same thing leave the reader to subtract, and every caller would have to
 * do it the same way for the answer to agree.
 *
 * The account overview does NOT subtract debt from its own totals. What it
 * reports is sliced by account — how this person's money is distributed —
 * while a debt belongs to the studio, is caused by everyone generating in it,
 * and exists once. Subtracting a shared debt from a per-account figure makes
 * two funders each lose the whole of it.
 * @param studioId - The studio to total.
 * @returns The total in credits, below zero when the studio owes.
 */
export async function getSpendableCredits(studioId: string): Promise<number> {
  return db.transaction(
    async (tx) => {
      const [lots, debt] = await Promise.all([
        creditLotRepo.sumSpendableForStudio(studioId, tx),
        creditLotRepo.readDebt(studioId, tx),
      ]);
      return spendableFrom(lots, debt);
    },
    { isolationLevel: "repeatable read" },
  );
}

/**
 * Subtract a studio's debt from its pool.
 *
 * Both figures have to come from the same instant for the difference to be a
 * number the studio was ever at: a charge that empties the pool and records
 * what it could not cover commits both halves at once, and reading them
 * separately can catch the pool before it and the debt after it.
 * @param lots - The sum of what the studio's lots hold.
 * @param debt - What the studio owes.
 * @returns The difference, in credits.
 */
function spendableFrom(lots: string, debt: string): number {
  return (toMicroCredits(lots) - toMicroCredits(debt)) / 1_000_000;
}

/** Everything one studio's credits page reads, as of one instant. */
export interface StudioCreditsSnapshot {
  spendable: number;
  debt: number;
  lots: creditLotRepo.StudioLot[];
  ledger: creditLotRepo.StudioLedgerRow[];
}

/**
 * Read a studio's credits page from a single snapshot.
 *
 * The page is an arithmetic claim — the lots plus what is owed add up to the
 * figure at the top — and four statements outside a transaction each see
 * their own instant. One generation committing between them leaves a screen
 * whose rows never summed to its total at any point in time.
 *
 * This is what the tab opens with. Scrolling asks for ledger lines on their
 * own, which is one statement and needs no snapshot.
 * @param studioId - The studio being read.
 * @param limit - How many ledger lines to take.
 * @returns The four figures, all as of the same instant.
 */
export async function readStudioCredits(
  studioId: string,
  limit: number,
): Promise<StudioCreditsSnapshot> {
  return db.transaction(
    async (tx) => {
      const [lots, debt, designated, ledger] = await Promise.all([
        creditLotRepo.sumSpendableForStudio(studioId, tx),
        creditLotRepo.readDebt(studioId, tx),
        creditLotRepo.listLotsByStudio(studioId, tx),
        creditLotRepo.listLedgerByStudio(studioId, limit, null, tx),
      ]);
      return {
        spendable: spendableFrom(lots, debt),
        debt: toMicroCredits(debt) / 1_000_000,
        lots: designated,
        ledger,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

/**
 * What a studio owes.
 *
 * The credits page shows it as its own line, and the precheck names the
 * amount when it turns a generation away.
 * @param studioId - The studio to read.
 * @returns The debt in credits; zero when it owes nothing.
 */
export async function getStudioDebt(studioId: string): Promise<number> {
  return toMicroCredits(await creditLotRepo.readDebt(studioId)) / 1_000_000;
}

/**
 * What an account holds that no studio can spend yet.
 * @param userId - The account to total.
 * @returns The total in credits.
 */
export async function getUnassignedCredits(userId: string): Promise<number> {
  return toMicroCredits(await creditLotRepo.sumUnassignedForUser(userId)) / 1_000_000;
}
