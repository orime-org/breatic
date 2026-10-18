// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Credit holds (inner#1611): what a studio has promised to work that is
 * running and not yet charged.
 *
 * An admission that only reads the balance lets every concurrent request see
 * the same credits and pass, and the charges that follow push the studio into
 * debt. Here an admission counts what the purchases hold, less the debt, less
 * every hold still counted, and writes its own hold before letting the work
 * start. Admissions and charges on one studio both take the studio's debt
 * lock first, so they queue and each sees what the one before it held.
 *
 * Holds exist only while payments are on; with payments off every admission
 * passes and nothing is written, as before.
 */

import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import * as creditLotRepo from "@domain/credit/creditLot.repo.js";
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";
import { positionFrom } from "@domain/credit/creditLot.service.js";
import { fromMicroCredits, toMicroCredits } from "@domain/credit/credit-math.js";
import { db, env } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { ProjectCreditsView } from "@breatic/shared";

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

/** What an admission came to. */
export type ReserveOutcome =
  | { ok: true }
  | {
      ok: false;
      studioId: string;
      /** Purchases less debt, before any hold. */
      spendable: number;
      /** What counted holds add up to. */
      held: number;
    };

/** A studio's credits as an admission sees them. */
export type CreditPosition = ProjectCreditsView;

/**
 * Take the studio's debt lock and read purchases less debt and the counted
 * holds, in micro-credits.
 * @param studioId - The studio.
 * @param tx - The transaction that takes and keeps the lock.
 * @returns Spendable and counted holds, in micro-credits.
 */
async function lockedRoom(studioId: string, tx: DbTx): Promise<{ spendable: number; held: number }> {
  const debt = await creditLotRepo.lockDebt(studioId, tx);
  const lots = await creditLotRepo.sumSpendableForStudio(studioId, tx);
  const held = await creditHoldRepo.sumHeldForStudio(studioId, tx);
  return { spendable: toMicroCredits(lots) - toMicroCredits(debt), held: toMicroCredits(held) };
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
 * @returns Admitted, or the figures the refusal is explained with.
 * @throws {Error} When the key already has a hold, held or released.
 * @throws {NotFoundError} When the project has no live studio.
 */
export async function reserveCredits(request: HoldRequest): Promise<ReserveOutcome> {
  if (!env.PAYMENT_ENABLED) return { ok: true };
  const studioId = await resolveOwnerStudioId(request.projectId);
  const amount = toMicroCredits(request.amount);
  return db.transaction(async (tx) => {
    const room = await lockedRoom(studioId, tx);
    if (room.spendable - room.held < amount) {
      return {
        ok: false,
        studioId,
        spendable: room.spendable / 1_000_000,
        held: room.held / 1_000_000,
      };
    }
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
  });
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
 * A studio's purchases less debt, its counted holds, and what is left, as of
 * one instant.
 * @param studioId - The studio.
 * @returns The three figures, in credits.
 */
export async function getCreditPosition(studioId: string): Promise<CreditPosition> {
  return db.transaction(
    async (tx) => {
      const [lots, debt, held] = await Promise.all([
        creditLotRepo.sumSpendableForStudio(studioId, tx),
        creditLotRepo.readDebt(studioId, tx),
        creditHoldRepo.sumHeldForStudio(studioId, tx),
      ]);
      return positionFrom(lots, debt, held);
    },
    { isolationLevel: "repeatable read" },
  );
}
