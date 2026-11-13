// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The worker's cross-region jobs (inner#1955): relaying this region's outbox,
 * reporting its storage use, and, in the global region, forwarding sign-in
 * claims and revocations to every other region and letting go of slugs held
 * for renames that never arrived.
 */

import type { Job } from "bullmq";
import { assetRepo, callRegion, env, getRegionsConfig, studioDirectoryRepo } from "@breatic/core";
import { globalApi, regionOutboxService } from "@breatic/domain";

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
 * @returns Once answered.
 * @throws {Error} When the region has no address or does not answer.
 */
async function askRegion(region: string, fn: string, args: unknown[]): Promise<void> {
  const url = env.REGION_API_URLS[region];
  if (url === undefined) throw new Error(`no address for region ${region}`);
  await callRegion(fn, args, {
    callerRegion: env.REGION,
    url,
    secret: env.INTERNAL_API_SECRET,
    timeoutMs: getRegionsConfig().global_api_timeout_ms,
  });
}

/**
 * Relay this region's outbox to the global region, in id order.
 * @returns What was delivered and set aside.
 * @throws {Error} When the outbox cannot be read.
 */
export async function relayRegionOutbox(): Promise<{ delivered: number; deadLettered: number }> {
  const result = await regionOutboxService.relayOutbox({
    deliver: (event) => globalApi().applyRegionEvent(env.REGION, event),
  });
  return { delivered: result.delivered, deadLettered: result.deadLettered };
}

/**
 * Report what this region's Studios store to the global region.
 * @returns How many Studios were reported.
 * @throws {Error} When the usage cannot be read or the global region does not answer.
 */
export async function syncStorageUsage(): Promise<number> {
  const usage = await assetRepo.usagePerStudio();
  await globalApi().recordRegionUsage({ region: env.REGION, asOf: new Date(), usage });
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
 * Let go of slugs held for renames that never reached the global region.
 * @returns How many it let go.
 */
export async function sweepSlugReservations(): Promise<number> {
  return studioDirectoryRepo.releaseStaleSlugReservations(getRegionsConfig().slug_reservation_stale_ms);
}
