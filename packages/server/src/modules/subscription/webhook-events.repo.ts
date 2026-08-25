// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `stripe_webhook_events` table's one home (task #106, §8).
 *
 * One row per Stripe event we have acted on. The table exists for its primary
 * key: claiming an event and doing what it says share a transaction, so a
 * redelivery collides and the whole thing is abandoned.
 *
 * In server rather than core because only this service receives webhooks.
 */

import { stripeWebhookEvents } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/**
 * Records that an event is being acted on, refusing a redelivery.
 * @param eventId - Stripe's id for the event.
 * @param type - Its type, kept for looking into what happened later.
 * @param tx - The transaction everything the event does shares.
 * @returns Whether this is the first time we have seen it.
 */
export async function claimWebhookEvent(
  eventId: string,
  type: string,
  tx: DbTx,
): Promise<boolean> {
  const inserted = await tx
    .insert(stripeWebhookEvents)
    .values({ eventId, type })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}
