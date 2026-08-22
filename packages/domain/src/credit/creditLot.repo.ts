// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Data access for `credit_lots` and `credit_ledger` (task #11).
 *
 * Credit amounts cross this boundary as decimal strings and all arithmetic on
 * them is done by Postgres in `numeric`, never in JS: a charge is split across
 * lots, and doing that in binary floating point leaves a residue on a lot that
 * can neither be spent nor refunded.
 *
 * Two rules that the queries here exist to keep, both stated once so no caller
 * has to restate them:
 *
 *   1. "Spendable" means designated to a live studio and `active`. A lot
 *      pointing at a soft-deleted studio is unspendable and reads as
 *      unassigned — studios soft-delete and the foreign key is `restrict`, so
 *      nothing cascades and the column keeps pointing at a studio that is
 *      gone. Spelling this out per query is how the two halves drift apart and
 *      an account starts showing a number it cannot spend.
 *
 *   2. A lot is locked by `id` alone, and everything that decides whether it
 *      may be charged is re-read after the lock is held. Postgres re-evaluates
 *      a `FOR UPDATE` predicate against the row as it stands once the lock is
 *      granted and skips the row if it no longer matches — so putting
 *      `lifecycle` or `designated_studio_id` in the locking predicate makes the
 *      lock come back empty at the one moment it was needed.
 */

import { and, asc, desc, eq, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@breatic/core";
import type { ActivityCursor, DbTx } from "@breatic/core";
import {
  creditLots,
  creditLedger,
  studioCreditDebts,
  studios,
  projects,
} from "@breatic/core";
import type {
  CreditLotEntity,
  CreditLotLifecycle,
  CreditLedgerEntryEntity,
  CreditLedgerEntryType,
} from "@breatic/shared";

/**
 * What makes a lot spendable, stated once.
 *
 * Designated to a studio that is still there, and still `active`. The studio
 * check is half of it: studios soft-delete and the foreign key is `restrict`,
 * so nothing cascades and the column keeps pointing at a studio that is gone.
 * Every caller composes this rather than restating it — the two halves drifting
 * apart is how an account starts showing a number it cannot spend.
 * @param studioId - The studio whose pool is being read.
 * @returns The condition, to be combined with the caller's own.
 */
function spendableByStudio(studioId: string): SQL | undefined {
  return and(
    eq(creditLots.designatedStudioId, studioId),
    eq(creditLots.lifecycle, "active"),
    isNull(creditLots.deletedAt),
    isNull(studios.deletedAt),
  );
}

/**
 * What counts as one of a studio's purchases, stated once.
 *
 * Designated to a studio that is still there — and nothing about the
 * lifecycle. A lot spent to nothing is still a top-up this studio received,
 * and the block this feeds is what explains the number at the top of the
 * page: leaving spent lots out makes a studio that spent everything look
 * like one that was never given anything.
 *
 * The refund lifecycles are absent from here because they cannot reach it: a
 * lot under refund carries no designation at all, which `credit_lots`' own
 * check enforces (0063). Naming them would filter nothing.
 * @param studioId - The studio whose purchases are being read.
 * @returns The condition, to be combined with the caller's own.
 */
function purchasedByStudio(studioId: string): SQL | undefined {
  return and(
    eq(creditLots.designatedStudioId, studioId),
    isNull(creditLots.deletedAt),
    isNull(studios.deletedAt),
  );
}

/**
 * Map a raw `credit_lots` row to the shared entity.
 * @param row - The Drizzle row.
 * @returns The mapped entity.
 */
function toLotEntity(row: typeof creditLots.$inferSelect): CreditLotEntity {
  return {
    id: row.id,
    paymentId: row.paymentId,
    userId: row.userId,
    purchasedCredits: row.purchasedCredits,
    remainingCredits: row.remainingCredits,
    designatedStudioId: row.designatedStudioId,
    lifecycle: row.lifecycle as CreditLotLifecycle,
    refundAttempts: row.refundAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Map a raw `credit_ledger` row to the shared entity.
 * @param row - The Drizzle row.
 * @param names - Display names joined alongside the row.
 * @param names.actorName - Who spent it, by display name.
 * @param names.projectName - Where it was spent, by name.
 * @returns The mapped entity.
 */
function toLedgerEntity(
  row: typeof creditLedger.$inferSelect,
  names: { actorName: string | null; projectName: string | null } = {
    actorName: null,
    projectName: null,
  },
): CreditLedgerEntryEntity {
  return {
    actorName: names.actorName,
    projectName: names.projectName,
    id: row.id,
    payerUserId: row.payerUserId,
    actorUserId: row.actorUserId,
    lotId: row.lotId,
    studioId: row.studioId,
    projectId: row.projectId,
    entryType: row.entryType as CreditLedgerEntryType,
    amount: row.amount,
    model: row.model,
    provider: row.provider,
    tokensUsed: row.tokensUsed,
    description: row.description,
    referenceId: row.referenceId,
    createdAt: row.createdAt,
  };
}

/**
 * Open a lot for a payment that has completed.
 *
 * The lot is born unassigned and therefore unspendable, with no branch for
 * anything else: a buyer may top up several times in a row, and asking which
 * studio each one is for mid-purchase puts two decisions in one flow.
 * Designation is its own step.
 *
 * The unique constraint on `payment_id` is what makes a redelivered webhook a
 * failed insert rather than a second grant, so this deliberately does not
 * swallow the conflict — the caller decides what a duplicate means.
 * @param data - The purchase this lot records.
 * @param data.paymentId - The completed payment. Unique across lots.
 * @param data.userId - Who paid.
 * @param data.purchasedCredits - How many credits the payment bought, as a decimal string.
 * @param tx - Optional transaction to join.
 * @returns The new lot.
 */
export async function createLot(
  data: { paymentId: string; userId: string; purchasedCredits: string },
  tx?: DbTx,
): Promise<CreditLotEntity> {
  const conn = tx ?? db;
  const rows = await conn
    .insert(creditLots)
    .values({
      paymentId: data.paymentId,
      userId: data.userId,
      purchasedCredits: data.purchasedCredits,
      remainingCredits: data.purchasedCredits,
      designatedStudioId: null,
      lifecycle: "active",
    })
    .returning();
  return toLotEntity(rows[0]!);
}

/**
 * The lots a studio may spend, oldest first.
 *
 * Ordered by `created_at` with `id` breaking ties, which is what "spend the
 * oldest purchase first" means in practice. This read takes no locks: it
 * chooses candidates, and each one is locked and re-checked individually
 * before anything is taken from it.
 * @param studioId - The studio whose pool to read.
 * @param tx - Optional transaction to join.
 * @returns Candidate lots in spend order.
 */
export async function listSpendableLots(
  studioId: string,
  tx?: DbTx,
): Promise<CreditLotEntity[]> {
  const conn = tx ?? db;
  const rows = await conn
    .select({ lot: creditLots })
    .from(creditLots)
    .innerJoin(studios, eq(studios.id, creditLots.designatedStudioId))
    .where(
      and(spendableByStudio(studioId), sql`${creditLots.remainingCredits} > 0`),
    )
    .orderBy(asc(creditLots.createdAt), asc(creditLots.id));
  return rows.map((row) => toLotEntity(row.lot));
}

/**
 * Take the row lock on one lot and read it back as it now stands.
 *
 * The predicate is the primary key and nothing else. Everything a caller
 * decides on — `lifecycle`, `remaining_credits`, `designated_studio_id` — is in
 * the returned row precisely because it may have changed while the lock was
 * being waited for; re-checking it here would only move the same race.
 * @param lotId - The lot to lock.
 * @param tx - The transaction holding the lock.
 * @returns The locked lot, or null if no such row exists.
 */
export async function lockLot(
  lotId: string,
  tx: DbTx,
): Promise<CreditLotEntity | null> {
  const rows = await tx
    .select()
    .from(creditLots)
    .where(eq(creditLots.id, lotId))
    .for("update");
  return rows[0] ? toLotEntity(rows[0]) : null;
}

/**
 * Subtract from a lot's remaining balance, in `numeric`.
 *
 * Reaching zero moves the lot to `depleted` in the same statement: a lot with
 * nothing left is not a lot anybody may take from, and leaving the two facts
 * to separate writes is what lets a query see one without the other. The
 * arithmetic happens in Postgres so the value written is exact to the column's
 * scale.
 *
 * The caller holds the row lock and has already decided this amount does not
 * exceed what is there; the database's own non-negative constraint is the
 * backstop if that is ever wrong.
 * @param lotId - The lot to charge.
 * @param amount - How much to take, as a positive decimal string.
 * @param tx - The transaction holding the lock.
 * @returns The lot's state after the charge.
 */
export async function applyCharge(
  lotId: string,
  amount: string,
  tx: DbTx,
): Promise<{ remainingCredits: string; lifecycle: CreditLotLifecycle }> {
  const result = await tx.execute(
    sql`UPDATE credit_lots
        SET remaining_credits = remaining_credits - ${amount}::numeric,
            lifecycle = CASE
              WHEN remaining_credits - ${amount}::numeric = 0 THEN 'depleted'
              ELSE lifecycle
            END,
            updated_at = NOW()
        WHERE id = ${lotId}
        RETURNING remaining_credits, lifecycle`,
  );
  const rows = result as unknown as Array<{
    remaining_credits: string;
    lifecycle: CreditLotLifecycle;
  }>;
  const row = rows[0]!;
  return { remainingCredits: row.remaining_credits, lifecycle: row.lifecycle };
}

/**
 * Append one row to the ledger.
 *
 * Every change to a lot's remaining balance writes one of these in the same
 * transaction, because the balance is defined as this table summed over that
 * lot. A charge that moved credits without appending here would make the two
 * disagree with nothing to detect it.
 * @param entry - What happened.
 * @param entry.payerUserId - Whose credits moved.
 * @param entry.entryType - Which of the four kinds of movement.
 * @param entry.amount - Signed decimal string: positive in, negative out.
 * @param entry.actorUserId - Who spent them, when that is someone.
 * @param entry.lotId - Which purchase was drawn down, when there is one.
 * @param entry.studioId - Where it happened.
 * @param entry.projectId - Which project it happened in.
 * @param entry.model - The model that consumed the credits.
 * @param entry.provider - The provider behind that model.
 * @param entry.tokensUsed - Tokens consumed, for text usage.
 * @param entry.description - A human-readable line.
 * @param entry.referenceId - Task or idempotency key; shared by every row of one charge.
 * @param tx - Optional transaction to join.
 * @returns The appended row.
 */
export async function appendLedgerEntry(
  entry: {
    payerUserId: string;
    entryType: CreditLedgerEntryType;
    amount: string;
    actorUserId?: string | null;
    lotId?: string | null;
    studioId?: string | null;
    projectId?: string | null;
    model?: string | null;
    provider?: string | null;
    tokensUsed?: number | null;
    description?: string | null;
    referenceId?: string | null;
  },
  tx?: DbTx,
): Promise<CreditLedgerEntryEntity> {
  const conn = tx ?? db;
  const rows = await conn
    .insert(creditLedger)
    .values({
      payerUserId: entry.payerUserId,
      entryType: entry.entryType,
      amount: entry.amount,
      actorUserId: entry.actorUserId ?? null,
      lotId: entry.lotId ?? null,
      studioId: entry.studioId ?? null,
      projectId: entry.projectId ?? null,
      model: entry.model ?? null,
      provider: entry.provider ?? null,
      tokensUsed: entry.tokensUsed ?? null,
      description: entry.description ?? null,
      referenceId: entry.referenceId ?? null,
    })
    .returning();
  return toLedgerEntity(rows[0]!);
}

/**
 * What a studio can spend right now.
 * @param studioId - The studio to total.
 * @returns The sum as a decimal string; "0" when the studio has no live lots.
 */
export async function sumSpendableForStudio(studioId: string): Promise<string> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${creditLots.remainingCredits}), 0)::text` })
    .from(creditLots)
    .innerJoin(studios, eq(studios.id, creditLots.designatedStudioId))
    .where(spendableByStudio(studioId));
  return rows[0]?.total ?? "0";
}

/**
 * What a studio owes, read without locking.
 *
 * For display and for the precheck, both of which want the number as it
 * stands. The two writers take {@link lockDebt} instead.
 * @param studioId - The studio to read.
 * @returns The debt as a decimal string; "0" when the studio has never owed.
 */
export async function readDebt(studioId: string): Promise<string> {
  const rows = await db
    .select({ amount: studioCreditDebts.amount })
    .from(studioCreditDebts)
    .where(eq(studioCreditDebts.studioId, studioId));
  return rows[0]?.amount ?? "0";
}

/**
 * Put this studio's debt row under lock, creating it first if it is absent.
 *
 * Two statements, and the first one is why: `SELECT ... FOR UPDATE` on a row
 * that does not exist locks nothing, so two concurrent charges on a studio
 * that has never owed would both find nothing, both insert, and one would die
 * on the unique index — losing that charge at the exact moment first debt and
 * concurrency coincide. The insert claims the row, conceding to whoever got
 * there first; the select then has something to hold.
 * @param studioId - The studio whose debt is being changed.
 * @param tx - The transaction that will hold the lock.
 * @returns What is owed as of this lock, as a decimal string.
 */
export async function lockDebt(studioId: string, tx: DbTx): Promise<string> {
  await tx
    .insert(studioCreditDebts)
    .values({ studioId, amount: "0" })
    .onConflictDoNothing({ target: studioCreditDebts.studioId });
  const rows = await tx
    .select({ amount: studioCreditDebts.amount })
    .from(studioCreditDebts)
    .where(eq(studioCreditDebts.studioId, studioId))
    .for("update");
  return rows[0]!.amount;
}

/**
 * Move a studio's debt by a signed amount, in `numeric`.
 *
 * The arithmetic happens in Postgres so the value written is exact to the
 * column's scale, the same reason {@link applyCharge} does. The caller holds
 * the lock from {@link lockDebt} and has already decided the move is within
 * range; the column's non-negative constraint is the backstop.
 * @param studioId - The studio whose debt moves.
 * @param delta - Signed decimal string: positive to owe more, negative to pay down.
 * @param tx - The transaction holding the lock.
 * @returns What is owed afterwards, as a decimal string.
 */
export async function adjustDebt(
  studioId: string,
  delta: string,
  tx: DbTx,
): Promise<string> {
  const result = await tx.execute(
    sql`UPDATE studio_credit_debts
        SET amount = amount + ${delta}::numeric, updated_at = NOW()
        WHERE studio_id = ${studioId}
        RETURNING amount`,
  );
  const rows = result as unknown as Array<{ amount: string }>;
  return rows[0]!.amount;
}

/**
 * What an account holds that is not yet spendable anywhere.
 *
 * Both halves of "unassigned" are here: a lot with no studio, and a lot whose
 * studio has been deleted. The second reads as unassigned everywhere — the
 * user sees "unassigned" rather than the name of a studio that is gone, and
 * can designate it again — so leaving it out would report money that exists
 * but that nothing can reach.
 * @param userId - The account to total.
 * @returns The sum as a decimal string; "0" when there is none.
 */
export async function sumUnassignedForUser(userId: string): Promise<string> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${creditLots.remainingCredits}), 0)::text` })
    .from(creditLots)
    .leftJoin(studios, eq(studios.id, creditLots.designatedStudioId))
    .where(
      and(
        eq(creditLots.userId, userId),
        eq(creditLots.lifecycle, "active"),
        isNull(creditLots.deletedAt),
        or(isNull(creditLots.designatedStudioId), isNotNull(studios.deletedAt)),
      ),
    );
  return rows[0]?.total ?? "0";
}

/**
 * Point a lot at a studio, or at nothing.
 *
 * The caller holds the row lock and has already checked that the lifecycle
 * permits it and that the buyer administers the target.
 * @param lotId - The lot to designate.
 * @param studioId - The studio to point it at, or null to unassign it.
 * @param tx - The transaction holding the lock.
 * @returns The lot as it now stands.
 */
export async function setDesignation(
  lotId: string,
  studioId: string | null,
  tx: DbTx,
): Promise<CreditLotEntity> {
  const rows = await tx
    .update(creditLots)
    .set({ designatedStudioId: studioId })
    .where(eq(creditLots.id, lotId))
    .returning();
  return toLotEntity(rows[0]!);
}

/**
 * One account's purchases, newest first, one keyset page at a time.
 *
 * Keyset rather than offset: a purchase landing while someone pages would
 * shift every later row down by one under an offset, which shows a row twice
 * and hides another.
 * @param userId - Whose purchases to list.
 * @param limit - How many rows to return.
 * @param cursor - The `(created_at, id)` of the previous page's last row.
 * @returns The page, newest first.
 */
export async function listLotsByUser(
  userId: string,
  limit: number,
  cursor: ActivityCursor | null,
): Promise<CreditLotEntity[]> {
  const rows = await db
    .select()
    .from(creditLots)
    .where(
      and(
        eq(creditLots.userId, userId),
        isNull(creditLots.deletedAt),
        cursor
          ? or(
              lt(creditLots.createdAt, cursor.createdAt),
              and(eq(creditLots.createdAt, cursor.createdAt), lt(creditLots.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(creditLots.createdAt), desc(creditLots.id))
    .limit(limit);
  return rows.map(toLotEntity);
}

/** One purchase a studio received, with the buyer's display name. */
export interface StudioPurchase extends CreditLotEntity {
  /** Who bought it. Absent when their personal studio is gone. */
  buyerName: string | null;
}

/**
 * Every top-up designated to a studio, oldest first.
 *
 * The buyer's name comes from their personal studio, which is where display
 * names live — `users` is the pure auth table. It is a different person from
 * the one on a ledger row: this is who put the money in, that is who spent
 * it.
 * @param studioId - The studio to read.
 * @returns Its purchases, oldest first.
 */
export async function listPurchasesByStudio(
  studioId: string,
): Promise<StudioPurchase[]> {
  const buyerStudio = alias(studios, "buyer_studio");
  const rows = await db
    .select({ lot: creditLots, buyerName: buyerStudio.name })
    .from(creditLots)
    .innerJoin(studios, eq(studios.id, creditLots.designatedStudioId))
    .leftJoin(
      buyerStudio,
      and(
        eq(buyerStudio.createdByUserId, creditLots.userId),
        eq(buyerStudio.type, "personal"),
        isNull(buyerStudio.deletedAt),
      ),
    )
    .where(purchasedByStudio(studioId))
    .orderBy(asc(creditLots.createdAt), asc(creditLots.id));
  return rows.map((row) => ({
    ...toLotEntity(row.lot),
    buyerName: row.buyerName,
  }));
}

/**
 * One account's ledger, newest first, one keyset page at a time.
 *
 * Always taken by payer: this answers "where did my money go", and the person
 * who spent it is a column on each row rather than a way of selecting them.
 * @param payerUserId - Whose credits moved.
 * @param limit - How many rows to return.
 * @param cursor - The `(created_at, id)` of the previous page's last row.
 * @param studioId - Narrow to one studio, when asked for.
 * @returns The page, newest first.
 */
export async function listLedgerByPayer(
  payerUserId: string,
  limit: number,
  cursor: ActivityCursor | null,
  studioId?: string,
): Promise<CreditLedgerEntryEntity[]> {
  // Display names live on the personal studio (`users` is the pure auth
  // table), the same place the activity feed reads an actor's name from.
  const actorStudio = alias(studios, "actor_studio");
  const rows = await db
    .select({
      entry: creditLedger,
      actorName: actorStudio.name,
      projectName: projects.name,
    })
    .from(creditLedger)
    .leftJoin(
      actorStudio,
      and(
        eq(actorStudio.createdByUserId, creditLedger.actorUserId),
        eq(actorStudio.type, "personal"),
        isNull(actorStudio.deletedAt),
      ),
    )
    .leftJoin(projects, eq(projects.id, creditLedger.projectId))
    .where(
      and(
        eq(creditLedger.payerUserId, payerUserId),
        studioId ? eq(creditLedger.studioId, studioId) : undefined,
        cursor
          ? or(
              lt(creditLedger.createdAt, cursor.createdAt),
              and(
                eq(creditLedger.createdAt, cursor.createdAt),
                lt(creditLedger.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(limit);
  return rows.map((row) =>
    toLedgerEntity(row.entry, {
      actorName: row.actorName,
      projectName: row.projectName,
    }),
  );
}

/**
 * What each studio has spent of one account's money.
 *
 * Both conditions are load-bearing. Without the payer, a studio that changed
 * hands still carries the previous owner's spending under this `studio_id`,
 * and it would land on the wrong person's panel. And this cannot be derived
 * from `purchased - remaining` on the lots: spending that happened before a
 * lot was reassigned would move to the studio it was reassigned to, which
 * contradicts a purchase's history being fixed once written.
 * @param payerUserId - Whose money to account for.
 * @returns One entry per studio the account has spent in.
 */
export async function sumSpentByStudio(
  payerUserId: string,
): Promise<{ studioId: string; spent: string }[]> {
  const rows = await db
    .select({
      studioId: creditLedger.studioId,
      spent: sql<string>`(-SUM(${creditLedger.amount}))::text`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.payerUserId, payerUserId),
        eq(creditLedger.entryType, "spend"),
        isNotNull(creditLedger.studioId),
        // Only rows that actually drew down a purchase. The three paths that
        // record usage without charging write the same entry type with no lot,
        // and counting those reports money that never left the account.
        isNotNull(creditLedger.lotId),
      ),
    )
    .groupBy(creditLedger.studioId);
  return rows
    .filter((row): row is { studioId: string; spent: string } => row.studioId !== null)
    .map((row) => ({ studioId: row.studioId, spent: row.spent }));
}

/**
 * How much each studio can spend of one account's money, per studio.
 * @param userId - Whose lots to group.
 * @returns One entry per studio holding a live lot of this account's.
 */
export async function sumSpendableByStudio(
  userId: string,
): Promise<{ studioId: string; spendable: string }[]> {
  const rows = await db
    .select({
      studioId: creditLots.designatedStudioId,
      spendable: sql<string>`SUM(${creditLots.remainingCredits})::text`,
    })
    .from(creditLots)
    .innerJoin(studios, eq(studios.id, creditLots.designatedStudioId))
    .where(
      and(
        eq(creditLots.userId, userId),
        eq(creditLots.lifecycle, "active"),
        isNull(creditLots.deletedAt),
        isNull(studios.deletedAt),
      ),
    )
    .groupBy(creditLots.designatedStudioId);
  // Same three conditions as `spendableByStudio`, grouped instead of pinned to
  // one studio — the shared helper takes a studio id, which this one does not
  // have.
  return rows
    .filter((row): row is { studioId: string; spendable: string } => row.studioId !== null)
    .map((row) => ({ studioId: row.studioId, spendable: row.spendable }));
}

/**
 * Read one lot by id, without locking it.
 * @param lotId - The lot to read.
 * @returns The lot, or null if there is no live row with that id.
 */
export async function findLotById(lotId: string): Promise<CreditLotEntity | null> {
  const rows = await db
    .select()
    .from(creditLots)
    .where(and(eq(creditLots.id, lotId), isNull(creditLots.deletedAt)))
    .limit(1);
  return rows[0] ? toLotEntity(rows[0]) : null;
}
