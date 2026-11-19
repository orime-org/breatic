// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The processed set the Stripe catch-up skips (inner#1993 §8.5): an event id
 * claimed in `stripe_webhook_events`, or one some attempt answered with a 2xx.
 * An attempt that answered 5xx, or never finished, leaves the event to do.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { closeDb, initCore } from "@breatic/core";
import { processedEventIds } from "@server/modules/stripe-webhook/catch-up.js";
import { beginAttempt, finishAttempt } from "@server/modules/stripe-webhook/attempts.repo.js";

let sql: ReturnType<typeof postgres>;
const attemptIds: string[] = [];

/**
 * Record one attempt for an event, finished with `status` unless null.
 * @param eventId - The event.
 * @param status - The response it answered, or null for an unfinished one.
 */
async function attempt(eventId: string, status: 200 | 500 | null): Promise<void> {
  const id = randomUUID();
  attemptIds.push(id);
  await beginAttempt({
    id, eventId, eventType: "invoice.paid", livemode: false, accountId: null, endpointId: null,
    connectedAccountId: null, environment: "test", receivedAt: new Date(),
  });
  if (status !== null) await finishAttempt({ id, responseStatus: status, result: status === 200 ? "ignored" : "handler_exception" });
}

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "stripe-processed-set-test" } });
});

afterAll(async () => {
  try {
    if (attemptIds.length > 0) await sql`update stripe_webhook_attempts set deleted_at = now() where id = any(${attemptIds}::uuid[])`;
  } finally {
    await sql?.end({ timeout: 1 });
    await closeDb();
  }
});

describe("processedEventIds", () => {
  it("holds claimed events and events an attempt answered 2xx, and nothing else", async () => {
    const tag = randomUUID();
    const claimed = `evt_claimed_${tag}`;
    const answered = `evt_answered_${tag}`;
    const failed = `evt_failed_${tag}`;
    const unfinished = `evt_unfinished_${tag}`;
    const unseen = `evt_unseen_${tag}`;
    await sql`insert into stripe_webhook_events (event_id, type) values (${claimed}, 'refund.updated')`;
    await attempt(answered, 500);
    await attempt(answered, 200);
    await attempt(failed, 500);
    await attempt(unfinished, null);

    const set = await processedEventIds([claimed, answered, failed, unfinished, unseen]);

    expect([...set].sort()).toEqual([answered, claimed].sort());
  });

  it("answers an empty set for no ids without querying", async () => {
    expect(await processedEventIds([])).toEqual(new Set());
  });
});
