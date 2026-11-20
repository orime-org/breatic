// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storing what the billing service read from Stripe about a subscription
 * (inner#1993 §3.3 `subscription-facts`, §4.3): the projection, the first
 * payment, the tier and its notices in one transaction, once per delivery;
 * the ended-membership email and the start report after the commit.
 */

import { fingerprint, type SubscriptionFactRequest } from "@breatic/core";
import { getUserById } from "@server/modules/auth/user.repo.js";
import { answerOnce } from "@server/modules/commerce/commerce-request.service.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { applySubscriptionWrite } from "@server/modules/account/apply-subscription.js";
import { sendMembershipEndedMail } from "@server/modules/account/settle-tier.js";
import { reportSubscriptionStarted } from "@server/modules/account/subscription-analytics.js";

const ROUTE = "/internal/v1/commerce/subscription-facts/:deliveryId";

/**
 * Store one subscription fact once per delivery.
 * @param deliveryId - The billing service's outbox row the fact was sent from.
 * @param request - The fact, its notices and, on a first activation, the start to report.
 * @returns 200 `{ tier, endedFrom }`; 404 `account_not_found`; 422 for a reused key.
 * @throws {Error} When the database fails; nothing is stored, so the redelivery applies it.
 */
export async function applySubscriptionFact(deliveryId: string, request: SubscriptionFactRequest): Promise<StoredAnswer> {
  const { userId, fact } = request;
  let endedFrom: string | null = null;
  let applied = false;
  const answer = await answerOnce(
    { key: `fact:${deliveryId}`, kind: "fact", hash: fingerprint("PUT", ROUTE, deliveryId, request) },
    async (tx) => {
      if ((await getUserById(userId, tx)) === null) {
        return { status: "refused", httpStatus: 404, body: { code: "account_not_found" } };
      }
      const result = await applySubscriptionWrite({
        userId,
        write: {
          userId,
          stripeSubscriptionId: fact.stripeSubscriptionId,
          tier: fact.tier,
          period: fact.period,
          status: fact.status,
          currentPeriodEnd: fact.currentPeriodEnd === null ? null : new Date(fact.currentPeriodEnd),
          cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
          stripeItemId: null,
          hasPendingUpdate: fact.hasPendingUpdate,
          pendingTier: fact.pendingTier,
          pendingPeriod: fact.pendingPeriod,
          payableInvoiceUrl: null,
          observedAt: new Date(fact.observedAt),
        },
        referenceId: `fact:${deliveryId}`,
        firstActiveAt: fact.firstActiveAt === null ? null : new Date(fact.firstActiveAt),
        tx,
      });
      for (const notice of request.notices) {
        await notificationService.createMembershipUpgradeIncomplete({
          userId,
          payload: { toTier: notice.toTier, toPeriod: notice.toPeriod },
          tx,
        });
      }
      applied = true;
      endedFrom = result.endedFrom;
      return { status: "applied", httpStatus: 200, body: { tier: result.tier, endedFrom: result.endedFrom } };
    },
  );
  if (applied) {
    if (endedFrom !== null) await sendMembershipEndedMail(userId, endedFrom);
    if (request.started !== null) reportSubscriptionStarted(userId, request.started);
  }
  return answer;
}
