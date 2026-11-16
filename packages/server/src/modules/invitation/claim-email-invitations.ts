// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createQueue, defaultJobOpts, env, INVITATION_CLAIM_FORWARD_QUEUE, isRegionUnavailable, logger, otherRegionsOf } from "@breatic/core";
import { normalizeEmail } from "@breatic/shared";
import type { UserEntity } from "@breatic/shared";
import { claimInvitation, invitationRepo } from "@server/modules/invitation/invitation-lifecycle.service.js";

/**
 * Convert each live mailbox invitation independently for a verified account.
 * Candidate and transaction failures are logged so account and session creation
 * can complete and the next authenticated session can retry the scan.
 * @param user - The account whose verified mailbox may have invitations.
 * @returns Once the scan has finished: the first global-region outage a
 *   candidate met, or null (inner#1955).
 */
export async function claimEmailInvitations(user: Pick<UserEntity, "id" | "email" | "emailVerified">): Promise<{ unavailable: unknown }> {
  if (!user.emailVerified) return { unavailable: null };
  let unavailable: unknown = null;
  try {
    for (const kind of ["project", "studio"] as const) {
      const candidates = await invitationRepo(kind).findPendingEmailCandidates(normalizeEmail(user.email));
      for (const candidate of candidates) {
        try {
          await claimInvitation(kind, candidate.id, candidate.targetId, user.id);
        } catch (err) {
          logger.error({ err, ctx: { userId: user.id, kind, invitationId: candidate.id } }, "email_invitation_claim_failed");
          if (unavailable === null && isRegionUnavailable(err)) unavailable = err;
        }
      }
    }
  } catch (err) {
    logger.error({ err, ctx: { userId: user.id } }, "email_invitation_claim_failed");
  }
  return { unavailable };
}

/**
 * Claim a signed-in account's email invitations for a job forwarded from the
 * global region: a global-region outage fails the job, which retries.
 * @param user - The account whose verified mailbox may have invitations.
 * @returns Once every candidate was claimed or failed for good.
 * @throws {GlobalApiError} When the global region was unavailable for a candidate.
 */
export async function claimForwardedEmailInvitations(user: Pick<UserEntity, "id" | "email" | "emailVerified">): Promise<void> {
  const { unavailable } = await claimEmailInvitations(user);
  if (unavailable !== null) throw unavailable;
}

let claimForwardQueue: ReturnType<typeof createQueue> | null = null;

/**
 * Claim a signed-in account's email invitations: this region's at once, and
 * every other region's through a worker job, so a slow or absent region
 * never slows sign-in. A job that cannot be queued is logged; the next
 * sign-in tries again.
 * @param user - The account whose verified mailbox may have invitations.
 * @returns Once this region's claims are done and the other regions' are queued.
 */
export async function claimEmailInvitationsOnSignIn(user: Pick<UserEntity, "id" | "email" | "emailVerified">): Promise<void> {
  if (!user.emailVerified) return;
  await claimEmailInvitations(user);
  const regions = otherRegionsOf(env);
  if (regions.length === 0) return;
  claimForwardQueue ??= createQueue(INVITATION_CLAIM_FORWARD_QUEUE);
  for (const region of regions) {
    try {
      await claimForwardQueue.add("claim", { region, userId: user.id }, defaultJobOpts());
    } catch (err) {
      logger.error({ err, ctx: { userId: user.id, region } }, "email_invitation_claim_forward_enqueue_failed");
    }
  }
}
