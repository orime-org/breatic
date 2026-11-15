// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The worker's cross-region jobs (inner#1955): relaying this region's outbox,
 * reporting its storage use, and, in the global region, forwarding sign-in
 * claims and revocations to every other region and letting go of slugs held
 * for renames that never arrived.
 */

import type { Job } from "bullmq";
import { assetRepo, callRegion, env, getRegionsConfig, GlobalApiError, isRegionUnavailable, logger, studioDirectoryRepo } from "@breatic/core";
import { directoryWrites, globalApi, regionOutboxService, studioDirectoryService } from "@breatic/domain";

/** A sign-in's claims for one other region. */
export interface InvitationClaimForwardJob {
  region: string;
  userId: string;
}

/** A revocation for one other region. */
export interface IdentityRevocationForwardJob {
  region: string;
  userId: string;
  sids: string[];
}

/**
 * Call one region's function; a failure throws so BullMQ retries the job.
 * @param region - The region.
 * @param fn - The function.
 * @param args - Its arguments.
 * @returns The region's answer.
 * @throws {Error} When the region has no address or does not answer.
 */
async function askRegion(region: string, fn: string, args: unknown[]): Promise<unknown> {
  return callRegion(region, fn, args, getRegionsConfig().global_api_timeout_ms);
}

/**
 * Send one event to the global region. A refusal of the request itself
 * (such as a body over the internal limit) can never succeed, so the event
 * is set aside like one the global region cannot apply; an unavailable
 * global region throws and the relay stops to retry.
 * @param event - The event.
 * @returns How the global region took it.
 * @throws {Error} When the global region did not answer or failed for now.
 */
async function deliverEvent(event: regionOutboxService.OutboxEvent): Promise<"applied" | "duplicate" | "permanent_failure"> {
  try {
    return await globalApi().applyRegionEvent(env.REGION, event);
  } catch (err) {
    if (err instanceof GlobalApiError && !isRegionUnavailable(err)) {
      logger.error({ err, region: env.REGION, eventId: event.id }, "region_outbox_event_refused");
      return "permanent_failure";
    }
    throw err;
  }
}

/**
 * Relay this region's outbox to the global region, in id order. Events set
 * aside raise an alert; a pass stopped by a failure throws it, so the job is
 * recorded as failed and the next pass resumes where this one stopped.
 * @returns What was delivered and set aside.
 * @throws {Error} When the outbox cannot be read or the global region stopped the pass.
 */
export async function relayRegionOutbox(): Promise<{ delivered: number; deadLettered: number }> {
  const result = await regionOutboxService.relayOutbox({ deliver: deliverEvent });
  if (result.deadLettered > 0) {
    logger.error({ region: env.REGION, deadLettered: result.deadLettered }, "region_outbox_dead_lettered");
  }
  if (result.stoppedBy !== undefined) throw result.stoppedBy;
  return { delivered: result.delivered, deadLettered: result.deadLettered };
}

/**
 * Report what this region's Studios store to the global region, in batches
 * measured at one instant.
 * @returns How many Studios were reported.
 * @throws {Error} When the usage cannot be read or the global region does not answer.
 */
export async function syncStorageUsage(): Promise<number> {
  // Stamped before measuring: of two overlapping runs, the one that measured
  // later always carries the later stamp, and the global region keeps it.
  const asOf = new Date();
  const usage = await assetRepo.usagePerStudio();
  const batch = getRegionsConfig().storage_usage_report_batch;
  for (let start = 0; start < usage.length; start += batch) {
    await globalApi().recordRegionUsage({ region: env.REGION, asOf, usage: usage.slice(start, start + batch) });
  }
  return usage.length;
}

/**
 * Hand a sign-in's email-invitation claims to one other region.
 * @param job - The region and the account.
 * @returns Once the region has claimed.
 * @throws {Error} When the region does not answer, so the job retries.
 */
export async function forwardInvitationClaim(job: Job<InvitationClaimForwardJob>): Promise<void> {
  await askRegion(job.data.region, "claimEmailInvitations", [job.data.userId]);
}

/**
 * Hand revoked session ids to one other region.
 * @param job - The region, the account and the session ids.
 * @returns Once the region has marked them.
 * @throws {Error} When the region does not answer, so the job retries.
 */
export async function forwardRevocation(job: Job<IdentityRevocationForwardJob>): Promise<void> {
  await askRegion(job.data.region, "revokeSessions", [job.data.userId, job.data.sids]);
}

/**
 * Settle slug reservations past due: ask each Studio's region which slug it
 * holds and whether events of the Studio are still on their way, then keep
 * or let go of the reservation; the sweep never writes the directory. A
 * region that does not answer has its reservations postponed a window and is
 * not asked again in the pass, so it cannot hold the head of every batch.
 * @returns How many were settled.
 * @throws {Error} When the reservations cannot be read.
 */
export async function sweepSlugReservations(): Promise<number> {
  let settled = 0;
  const silent = new Set<string>();
  for (const due of await studioDirectoryRepo.listDueSlugReservations(getRegionsConfig().slug_reservation_sweep_batch)) {
    const region = due.region ?? env.GLOBAL_REGION;
    try {
      if (silent.has(region)) {
        await directoryWrites.postponeSlugReservation(due.slug, due.studioId);
        continue;
      }
      const state = region === env.REGION
        ? await directoryWrites.slugState(due.studioId)
        : ((await askRegion(region, "studioSlugState", [due.studioId])) as directoryWrites.SlugState);
      await directoryWrites.settleSlugReservation(due.slug, due.studioId, state);
      settled += 1;
    } catch (err) {
      // The reservation stays held; a later sweep asks again.
      logger.error({ err, studioId: due.studioId, region }, "slug_reservation_settle_failed");
      silent.add(region);
      await directoryWrites.postponeSlugReservation(due.slug, due.studioId).catch((postponeErr: unknown) => {
        logger.error({ err: postponeErr, studioId: due.studioId, region }, "slug_reservation_postpone_failed");
      });
    }
  }
  return settled;
}

/**
 * Align the Studio directory with the global region's tables after an
 * upgrade, once: a deployment that has done it before does nothing. Run by
 * the global region's worker at start when `DIRECTORY_RECONCILE_ON_START` is
 * set, as the bundled docker-compose.yml does after the new server is up.
 * @returns How many Studios were aligned; 0 when not asked, outside the global region (the alignment's own check), or already done.
 * @throws {Error} When the tables cannot be read or written.
 */
export async function reconcileDirectoryOnStart(): Promise<number> {
  if (!env.DIRECTORY_RECONCILE_ON_START) return 0;
  return studioDirectoryService.reconcileDirectoryAfterUpgrade();
}
