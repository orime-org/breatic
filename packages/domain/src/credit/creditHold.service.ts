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
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";
import { fromMicroCredits, positionFrom, serializeCreditPosition, toChargeMicro, type CreditPositionMicro } from "@domain/credit/credit-math.js";
import { createQueue, db, env, getNodeTaskConfig, getRegionsConfig, isGlobalRegion, isRegionUnavailable } from "@breatic/core";
import { globalApi } from "@domain/region/global-api.js";
import type { DbTx } from "@breatic/core";
import type { ProjectCreditsView } from "@breatic/shared";

/** One hold asked for, against a Studio named directly or through its Project. */
export type HoldRequest = HoldFields & ({ studioId: string } | { projectId: string });

/** What every hold carries. */
export interface HoldFields {
  /** Who started the work. */
  actorUserId: string;
  /** The run's task id. Used once. */
  referenceId: string;
  /** Credits to hold. */
  amount: number;
  /** How long the hold counts if nothing releases it. */
  ttlMs: number;
}

/** What an admission came to: admitted, or refused with the studio's position. */
export type ReserveOutcome = { ok: true } | ({ ok: false; studioId: string } & ProjectCreditsView);

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
 * @returns Admitted, or the figures the refusal is explained with.
 * @throws {Error} When the key already has a hold, held or released.
 * @throws {NotFoundError} When the project has no live studio.
 */
export async function reserveCredits(request: HoldRequest): Promise<ReserveOutcome> {
  if (!env.PAYMENT_ENABLED) return { ok: true };
  // The Project is this region's; the credits are the global region's
  // (inner#1955). The Studio is read here and the hold taken there.
  const studioId = "studioId" in request ? request.studioId : await resolveOwnerStudioId(request.projectId);
  const hold = {
    studioId,
    actorUserId: request.actorUserId,
    referenceId: request.referenceId,
    amount: request.amount,
    ttlMs: request.ttlMs,
  };
  return globalApi().reserveCredits(hold);
}

/**
 * Take a hold in the region that holds the books.
 * @param request - The hold, against its Studio.
 * @returns Admitted, or refused with the Studio's position.
 */
export async function reserveHere(
  request: HoldFields & { studioId: string },
): Promise<ReserveOutcome> {
  if (!env.PAYMENT_ENABLED) return { ok: true };
  const { studioId } = request;
  const amount = toChargeMicro(request.amount);
  return db.transaction(async (tx) => {
    const position = await lockedPosition(studioId, tx);
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
  });
}

/** The queue that retries, in a region outside the global one, a release or abandon the global region could not take (inner#1955). */
export const CREDIT_HOLD_RELEASE_QUEUE = "credit-hold-release";

/** A queued release, or an abandon when it names the hold's Studio and actor. */
export interface HoldReleaseJob {
  referenceId: string;
  abandon?: { studioId: string; actorUserId: string };
  /** An extension to this ISO instant rather than a release. */
  extendUntil?: string;
}

/**
 * How a queued cleanup is named and keyed. An extension carries its target
 * in its id, so it never stands in for the hold's release or a later
 * extension: the queue ignores a job whose id it already holds.
 * @param job - The cleanup.
 * @returns The job's name and id.
 */
function queuedAs(job: HoldReleaseJob): { name: "release" | "abandon" | "extend"; jobId: string } {
  if (job.extendUntil !== undefined) return { name: "extend", jobId: `${job.referenceId}:extend:${Date.parse(job.extendUntil)}` };
  return { name: job.abandon === undefined ? "release" : "abandon", jobId: job.referenceId };
}

let releaseQueue: ReturnType<typeof createQueue> | null = null;

/**
 * Release a hold. Releasing one that is gone or already released does nothing.
 * Outside the global region a release that finds the global region
 * unavailable is queued and retried, so the Studio's credits are freed within
 * one retry interval of the global region coming back.
 * @param referenceId - Its key.
 * @throws {Error} When the database fails, the global region refuses, or the retry cannot be queued.
 */
export async function releaseHold(referenceId: string): Promise<void> {
  if (!env.PAYMENT_ENABLED) return;
  await orQueue(() => globalApi().releaseHold(referenceId), { referenceId });
}

/**
 * The retry a queued hold cleanup carries: one try every interval for as long
 * as a hold lives, so the cleanup lands within one interval of the global
 * region coming back while the hold still counts.
 * @returns The attempts and the fixed wait between them.
 */
export function holdCleanupRetry(): { attempts: number; backoff: { type: "fixed"; delay: number } } {
  const delay = getRegionsConfig().hold_cleanup_retry_interval_ms;
  return { attempts: Math.ceil(getNodeTaskConfig().default_budget_ms / delay) + 1, backoff: { type: "fixed", delay } };
}

/**
 * Run a cleanup of a hold through the global region; outside the global
 * region, one that finds the global region unavailable is queued and retried
 * while the hold lives (see {@link holdCleanupRetry}).
 * @param call - The cleanup.
 * @param job - The same cleanup as a queued job.
 * @returns Once done or queued.
 * @throws {Error} When the global region refuses, or the retry cannot be queued.
 */
async function orQueue(call: () => Promise<void>, job: HoldReleaseJob): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (isGlobalRegion(env) || !isRegionUnavailable(err)) throw err;
    releaseQueue ??= createQueue(CREDIT_HOLD_RELEASE_QUEUE);
    const { name, jobId } = queuedAs(job);
    await releaseQueue.add(name, job, {
      ...holdCleanupRetry(),
      removeOnComplete: true,
      removeOnFail: true,
      // A retry keeps every earlier stack trace unless told otherwise, and
      // the job hash is rewritten on each of its many tries.
      stackTraceLimit: 1,
      jobId,
    });
  }
}

/**
 * Run one queued cleanup; a throw makes the queue retry it.
 * @param job - The cleanup.
 * @returns Once released or given up.
 * @throws {Error} When the global region still does not take it.
 */
export async function runQueuedHoldRelease(job: HoldReleaseJob): Promise<void> {
  if (job.extendUntil !== undefined) await globalApi().extendHold(job.referenceId, job.extendUntil);
  else if (job.abandon === undefined) await globalApi().releaseHold(job.referenceId);
  else await globalApi().abandonHold({ ...job.abandon, referenceId: job.referenceId });
}

/**
 * Give up a hold after its reserve call failed: the books may have taken it
 * and lost only the answer, or may still be taking it.
 * @param request - The hold that was asked for.
 * @returns Once the key can hold nothing, or the abandon is queued for retry.
 * @throws {NotFoundError} When the project has no live studio.
 * @throws {Error} When the global region refuses, or the retry cannot be queued.
 */
export async function abandonHold(
  request: Pick<HoldFields, "actorUserId" | "referenceId"> & ({ studioId: string } | { projectId: string }),
): Promise<void> {
  if (!env.PAYMENT_ENABLED) return;
  const studioId = "studioId" in request ? request.studioId : await resolveOwnerStudioId(request.projectId);
  const { actorUserId, referenceId } = request;
  await orQueue(() => globalApi().abandonHold({ studioId, actorUserId, referenceId }), { referenceId, abandon: { studioId, actorUserId } });
}

/**
 * Give up a hold in the region that holds the books.
 * @param hold - The hold's Studio, actor and key.
 * @param hold.studioId - The Studio.
 * @param hold.actorUserId - Who started the work.
 * @param hold.referenceId - Its key.
 */
export async function abandonHere(hold: { studioId: string; actorUserId: string; referenceId: string }): Promise<void> {
  await creditHoldRepo.abandonHold(hold);
}

/**
 * Release a hold in the region that holds the books.
 * @param referenceId - Its key.
 */
export async function releaseHere(referenceId: string): Promise<void> {
  await creditHoldRepo.releaseHold(referenceId);
}

/**
 * Keep a task's hold alive while its cost is looked up after delivery (inner#1743): moved to a later expiry, never an
 * earlier one; a released hold stays released. The hold lives in the global region (inner#1955); outside it an
 * extension that finds the global region unavailable is queued and retried like a release.
 * @param referenceId - Its key, the task id.
 * @param until - The new expiry.
 * @returns Once extended or queued.
 * @throws {Error} When the global region refuses, or the retry cannot be queued.
 */
export async function extendHold(referenceId: string, until: Date): Promise<void> {
  if (!env.PAYMENT_ENABLED) return;
  const extendUntil = until.toISOString();
  await orQueue(() => globalApi().extendHold(referenceId, extendUntil), { referenceId, extendUntil });
}

/**
 * Extend a hold in the region that holds the books.
 * @param referenceId - Its key.
 * @param until - The new expiry, as an ISO instant.
 * @returns Once written.
 * @throws {Error} When the database fails.
 */
export async function extendHere(referenceId: string, until: string): Promise<void> {
  await creditHoldRepo.extendHold(referenceId, new Date(until));
}

/**
 * A Studio's designated lot balance less debt, its counted holds, and what is left, as of
 * one instant.
 * @param studioId - The studio.
 * @returns The three figures, in credits.
 */
export async function getCreditPosition(studioId: string): Promise<ProjectCreditsView> {
  return globalApi().getCreditPosition(studioId);
}

/**
 * A Studio's position read in the region that holds the books.
 * @param studioId - The studio.
 * @returns The three figures, in credits.
 */
export async function positionHere(studioId: string): Promise<ProjectCreditsView> {
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
