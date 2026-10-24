// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, getStripeWebhookRecordingWriteTimeoutMs, stripeWebhookAttempts } from "@breatic/core";
import type { AttemptCompletion, AttemptStart, CompletionState } from "@server/modules/stripe-webhook/types.js";

/**
 * Commits the receipt before the caller enters any business transaction.
 * @param input - The controlled identity and deployment metadata.
 * @throws {Error} If the statement or commit cannot be acknowledged.
 */
export async function beginAttempt(input: AttemptStart): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(getStripeWebhookRecordingWriteTimeoutMs())}, true)`);
    await tx.insert(stripeWebhookAttempts).values(input);
  });
}

/**
 * Saves the first terminal result in a transaction independent of business.
 * @param input - The response and finite result already formed by the handler.
 * @returns Whether this call saved the first result.
 * @throws {Error} If the statement or commit cannot be acknowledged.
 */
export async function finishAttempt(input: AttemptCompletion): Promise<CompletionState> {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(getStripeWebhookRecordingWriteTimeoutMs())}, true)`);
    const rows = await tx.update(stripeWebhookAttempts).set({
      responseStatus: input.responseStatus,
      result: input.result,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    }).where(and(eq(stripeWebhookAttempts.id, input.id), isNull(stripeWebhookAttempts.finishedAt), isNull(stripeWebhookAttempts.deletedAt))).returning({ id: stripeWebhookAttempts.id });
    return rows.length === 0 ? "already_finished" : "recorded";
  });
}
