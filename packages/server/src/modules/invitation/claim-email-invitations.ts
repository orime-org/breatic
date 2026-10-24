// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { logger } from "@breatic/core";
import { normalizeEmail } from "@breatic/shared";
import type { UserEntity } from "@breatic/shared";
import { claimInvitation, invitationRepo } from "@server/modules/invitation/invitation-lifecycle.service.js";

/**
 * Convert each live mailbox invitation independently for a verified account.
 * Candidate and transaction failures are logged so account and session creation
 * can complete and the next authenticated session can retry the scan.
 * @param user - The account whose verified mailbox may have invitations.
 * @returns Once the compensation scan has finished.
 */
export async function claimEmailInvitations(user: UserEntity): Promise<void> {
  if (!user.emailVerified) return;
  try {
    for (const kind of ["project", "studio"] as const) {
      const candidates = await invitationRepo(kind).findPendingEmailCandidates(normalizeEmail(user.email));
      for (const candidate of candidates) {
        try {
          await claimInvitation(kind, candidate.id, candidate.targetId, user.id);
        } catch (err) {
          logger.error({ err, ctx: { userId: user.id, kind, invitationId: candidate.id } }, "email_invitation_claim_failed");
        }
      }
    }
  } catch (err) {
    logger.error({ err, ctx: { userId: user.id } }, "email_invitation_claim_failed");
  }
}
