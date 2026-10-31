// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Settle ordinary subscription tiers through one shared path.
 *
 * Webhooks, checkout confirmation, subscription-panel actions and checkout
 * rechecks arrive through applySubscriptionWrite. A membership reading first
 * protects active or unresolved enterprise membership and self-hosted origins.
 * An actual pro/team-to-base change writes the ended bell in the transaction;
 * its email is sent after commit. Enterprise-to-base expiry does not produce
 * that ordinary subscription notice.
 */

import { changeMembershipTier, getMembershipReadingForUser } from "@breatic/core";
import type { DbTx, TierChangeReason } from "@breatic/core";
import { SUBSCRIBABLE_MEMBERSHIP_TIERS } from "@breatic/shared";
import type { MembershipTier } from "@breatic/shared";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { buildMembershipEndedMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";

/** The paid tiers whose actual ending produces the ordinary membership notice. */
const PAID_TIERS: ReadonlySet<string> = new Set<string>(SUBSCRIBABLE_MEMBERSHIP_TIERS);

/** What one settling of the tier did. */
export interface SettleTierResult {
  /** Whether the stored tier actually moved. */
  readonly changed: boolean;
  /** The tier the account was on before. */
  readonly fromTier: MembershipTier;
  /**
   * The paid tier that just ended, when one did.
   *
   * Non-null exactly when an email is owed. It is deliberately not sent from
   * here: this runs inside the caller's transaction, and a message about
   * something that then rolls back is worse than a late one. The caller sends
   * it with {@link sendMembershipEndedMail} after committing.
   */
  readonly endedFrom: MembershipTier | null;
}

/**
 * Moves an account's tier and, when a membership ended, rings the bell.
 *
 * The bell is written inside the caller's transaction on purpose: it is the
 * always-delivered channel, so if the tier change is abandoned the notice about
 * it has to be abandoned too.
 * The ledger reason is worked out here. It follows entirely from where the
 * tier lands, so a caller supplying it would be a second copy of one rule.
 * @param input - Who, where to, and the transaction to do it in.
 * @param input.userId - The account whose tier is settling.
 * @param input.toTier - The tier it should be on now.
 * @param input.referenceId - What identified the trigger upstream.
 * @param input.tx - The enclosing transaction, when there is one.
 * @returns What moved, and whether an email is owed.
 * @throws {Error} if the account is gone or its stored tier is unreadable.
 */
export async function settleTier(input: {
  userId: string;
  toTier: MembershipTier;
  referenceId?: string;
  tx?: DbTx;
}): Promise<SettleTierResult> {
  const reading = await getMembershipReadingForUser(input.userId, input.tx);
  if (reading.settlementProtected) {
    return { changed: false, fromTier: reading.storedTier, endedFrom: null };
  }

  const reason: TierChangeReason =
    input.toTier === "base" ? "subscription_ended" : "subscription_activated";

  const { changed, fromTier } = await changeMembershipTier(
    input.userId,
    input.toTier,
    reason,
    input.referenceId,
    input.tx,
  );

  const ended = changed && input.toTier === "base" && PAID_TIERS.has(fromTier);
  if (ended) {
    await notificationService.createMembershipEnded({
      userId: input.userId,
      payload: { fromTier },
      tx: input.tx,
    });
  }

  return { changed, fromTier, endedFrom: ended ? fromTier : null };
}

/** How the product writes each tier's name in a sentence. */
const TIER_LABEL: Readonly<Record<string, string>> = {
  pro: "PRO",
  team: "Team",
};

/**
 * Sends the membership-ended email, after the tier change has committed.
 *
 * Best-effort by design and by contract: the bell written inside the
 * transaction is the delivery guarantee, and `EMAIL_BACKEND` defaults to
 * `disabled`. A failure here is logged and goes no further — a webhook must
 * still answer 200, or Stripe redelivers an event we have already applied.
 *
 * Separate from {@link settleTier} because it must not run inside the caller's
 * transaction: an email about a change that then rolls back cannot be recalled.
 * @param userId - The account whose membership ended.
 * @param fromTier - The tier that ended.
 */
export async function sendMembershipEndedMail(
  userId: string,
  fromTier: MembershipTier,
): Promise<void> {
  await sendBestEffortMail(
    async () => {
      const user = await userRepo.getUserById(userId);
      if (!user) return null;
      return buildMembershipEndedMail({
        locale: user.locale,
        recipientEmail: user.email,
        tierLabel: TIER_LABEL[fromTier] ?? fromTier,
      });
    },
    { userId, subject: "membership_ended" },
  );
}
