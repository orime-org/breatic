// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one door a subscription's tier goes through (task #106, design §9).
 *
 * Every path that can move an account's tier because of Stripe comes here: the
 * webhook, and the reconciliation that runs when somebody opens the membership
 * panel. That matters for the notice attached to it, which is owed whenever the
 * account lands back on the free tier — and the four ways that happens do not
 * share an event. `unpaid` and `incomplete_expired` arrive as
 * `customer.subscription.updated` and produce no `deleted` at all, and the
 * reconciliation produces no Stripe event whatsoever. Hanging the notice on an
 * event type would cover one of the four.
 *
 * So it hangs on the RESULT: the tier moved, and where it landed is `base`.
 */

import { changeMembershipTier, getUserMembershipTier } from "@breatic/core";
import type { DbTx, TierChangeReason } from "@breatic/core";
import { SUBSCRIBABLE_MEMBERSHIP_TIERS } from "@breatic/shared";
import type { MembershipTier } from "@breatic/shared";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { buildMembershipEndedMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";

/**
 * The tiers a subscription is allowed to move an account between.
 *
 * The two it sells, plus the one an account falls back to when it sells it
 * nothing. Every other tier an account can be on got there some other
 * way and goes away some other way.
 */
const SUBSCRIPTION_GOVERNED_TIERS: ReadonlySet<string> = new Set<string>([
  "base",
  ...SUBSCRIBABLE_MEMBERSHIP_TIERS,
]);

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
 * @param input - Who, where to, why, and the transaction to do it in.
 * @param input.userId - The account whose tier is settling.
 * @param input.toTier - The tier it should be on now.
 * @param input.reason - Why it is moving, for the ledger row.
 * @param input.referenceId - What identified the trigger upstream.
 * @param input.tx - The enclosing transaction, when there is one.
 * @returns What moved, and whether an email is owed.
 * @throws {Error} if the account is gone or its stored tier is unreadable.
 */
export async function settleTier(input: {
  userId: string;
  toTier: MembershipTier;
  reason: TierChangeReason;
  referenceId?: string;
  tx?: DbTx;
}): Promise<SettleTierResult> {
  const stored = await getUserMembershipTier(input.userId, input.tx);
  if (!SUBSCRIPTION_GOVERNED_TIERS.has(stored)) {
    // Stripe has no say over this account's tier. `enterprise` is negotiated
    // and `self_hosted` is a deployment shape; neither was ever sold as a
    // subscription, so "there is no live subscription" says nothing about
    // them. Without this the reconciliation writes `base` over both — and it
    // runs for any account that ever had a Stripe customer, which one press
    // of the subscribe button is enough to create. The read side already
    // refuses to touch these (`honouredTier`); this is the same refusal on
    // the write side, where it was missing.
    return { changed: false, fromTier: stored, endedFrom: null };
  }

  const { changed, fromTier } = await changeMembershipTier(
    input.userId,
    input.toTier,
    input.reason,
    input.referenceId,
    input.tx,
  );

  // Landing on `base` from `base` is not an ending, and neither is moving
  // between two paid tiers — the account still has a membership.
  const ended = changed && input.toTier === "base" && fromTier !== "base";
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
        recipientEmail: user.email,
        tierLabel: TIER_LABEL[fromTier] ?? fromTier,
      });
    },
    { userId, subject: "membership_ended" },
  );
}
