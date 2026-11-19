// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe catch-up after a stop (inner#1993 §8.5 event K, §9.5): processing
 * stopped at some moment; Stripe kept every event, and redelivers a failed one
 * for three days. The catch-up lists the event types the webhook handles from
 * a lookback before that moment, skips the processed set (`stripe_webhook_events`
 * claims and attempts answered 2xx), and sends the rest through the webhook's
 * own recording and dispatch, oldest first.
 */

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { StripeWebhookResult } from "@breatic/shared";
import { REFUND_EVENT_TYPES } from "@server/modules/credit-refund/refund-webhook.js";
import { SHARED_SESSION_EVENT_TYPES, SUBSCRIPTION_EVENT_TYPES } from "@server/modules/subscription/subscription-events.js";
import { listClaimedEventIds } from "@server/modules/subscription/webhook-events.repo.js";
import { listAnsweredEventIds } from "@server/modules/stripe-webhook/attempts.repo.js";
import { dispatchStripeWebhook } from "@server/modules/stripe-webhook/dispatch.service.js";
import { finishWebhookAttempt, parseWebhookIdentity, startWebhookAttempt } from "@server/modules/stripe-webhook/recording.service.js";

/** Every event type the webhook handles; Stripe's list takes at most 20. */
export const CATCH_UP_EVENT_TYPES: readonly string[] = [
  ...SHARED_SESSION_EVENT_TYPES,
  ...SUBSCRIPTION_EVENT_TYPES,
  "invoice.paid",
  ...REFUND_EVENT_TYPES,
];

/** What {@link catchUpStripeEvents} works through. */
export interface CatchUpDeps {
  /** Stripe's events of these types created at or after `createdGte` (seconds), in any order. */
  listEvents: (query: { types: readonly string[]; createdGte: number }) => AsyncIterable<Stripe.Event>;
  /** Which of these ids are already processed. */
  processedIds: (ids: string[]) => Promise<Set<string>>;
  /** Process one event the way the webhook does. */
  handle: (event: Stripe.Event) => Promise<{ responseStatus: number }>;
  /** Log an event whose processing answered non-2xx (`responseStatus`) or threw (`err`). */
  onFailed: (eventId: string, cause: { responseStatus: number } | { err: unknown }) => void;
}

/** What one catch-up did. */
export interface CatchUpOutcome {
  listed: number;
  skipped: number;
  handled: number;
  /** Events whose processing answered non-2xx or threw; the run is not clean while any remain. */
  failed: string[];
}

/**
 * Work through the events Stripe holds from `lookbackHours` before `since`.
 * @param deps - Where events come from, the processed set and the handler.
 * @param since - The moment processing stopped.
 * @param lookbackHours - How far before it to list from.
 * @returns How many were listed, skipped, handled and which failed.
 */
export async function catchUpStripeEvents(deps: CatchUpDeps, since: Date, lookbackHours: number): Promise<CatchUpOutcome> {
  const events: Stripe.Event[] = [];
  const createdGte = Math.floor(since.getTime() / 1000) - lookbackHours * 3600;
  for await (const event of deps.listEvents({ types: CATCH_UP_EVENT_TYPES, createdGte })) events.push(event);
  events.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const processed = await deps.processedIds(events.map((e) => e.id));
  const outcome: CatchUpOutcome = { listed: events.length, skipped: 0, handled: 0, failed: [] };
  for (const event of events) {
    if (processed.has(event.id)) {
      outcome.skipped += 1;
      continue;
    }
    try {
      const { responseStatus } = await deps.handle(event);
      if (responseStatus >= 200 && responseStatus < 300) {
        outcome.handled += 1;
      } else {
        outcome.failed.push(event.id);
        deps.onFailed(event.id, { responseStatus });
      }
    } catch (err) {
      outcome.failed.push(event.id);
      deps.onFailed(event.id, { err });
    }
  }
  return outcome;
}

/**
 * The processed set among these ids: claimed events and events an attempt answered 2xx.
 * @param ids - The ids to look up.
 * @returns The processed ones.
 */
export async function processedEventIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [claimed, answered] = await Promise.all([listClaimedEventIds(ids), listAnsweredEventIds(ids)]);
  return new Set([...claimed, ...answered]);
}

/**
 * Process one event through the webhook's recording and dispatch, with the
 * webhook's failure rules (`middleware/stripe-webhook-recording.ts`): the
 * start must be recorded before dispatch; a failure to record the outcome is
 * reported and leaves the outcome as dispatched; a dispatch error is recorded
 * as `handler_exception` and is the error that propagates.
 * @param event - The event Stripe holds.
 * @param onRecordFailed - Log a failure to record the outcome.
 * @returns The status the webhook would have answered.
 * @throws {Error} When the event's shape cannot be recorded, the start cannot be recorded, or dispatch fails.
 */
export async function handleLikeWebhook(
  event: Stripe.Event,
  onRecordFailed: (stage: "finish", err: unknown) => void,
): Promise<{ responseStatus: number }> {
  const identity = parseWebhookIdentity(event);
  if (identity === null) throw new Error(`event ${event.id} has no recordable identity`);
  const id = randomUUID();
  await startWebhookAttempt(id, identity, new Date());
  /**
   * Record the outcome; a failure is reported, never raised.
   * @param status - The response status.
   * @param result - The processing result.
   */
  const finish = async (status: number, result: StripeWebhookResult): Promise<void> => {
    try {
      await finishWebhookAttempt(id, status, result);
    } catch (err) {
      onRecordFailed("finish", err);
    }
  };
  let dispatched: Awaited<ReturnType<typeof dispatchStripeWebhook>>;
  try {
    dispatched = await dispatchStripeWebhook(event);
  } catch (err) {
    await finish(500, "handler_exception");
    throw err;
  }
  await finish(dispatched.responseStatus, dispatched.result);
  return { responseStatus: dispatched.responseStatus };
}
