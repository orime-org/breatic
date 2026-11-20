// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sends the product's outbox to the billing service (inner#1993 §3.4, §5.2).
 * Each row is claimed in a transaction of its own and delivered, signed as
 * `product`, while the row is held: an answered row is marked sent; a
 * permanent failure or a refusal moves it to the dead letters; an unavailable
 * billing service puts it back with a backoff until `relay_max_attempts`.
 */

import {
  SignedCallError,
  commerceOutboxRepo,
  db,
  env,
  getCommerceConfig,
  inboxAnswerSchema,
  isUnavailable,
  logger,
  nextAttemptDelaySeconds,
  signedCall,
  startRelayLoop,
  type DbTx,
  type RelayForward,
  type RelayLoop,
} from "@breatic/core";

/** The name the product signs as on the billing service's listener. */
const PRODUCT_SIGNER = "product";

/**
 * Give a row up.
 * @param row - The claimed row.
 * @param attempts - Attempts made, this one included.
 * @param err - Why the last attempt failed.
 * @param reason - Why it is given up.
 * @param tx - The relay's transaction.
 * @returns What the relay loop reports.
 */
async function giveUp(
  row: commerceOutboxRepo.CommerceOutboxRow,
  attempts: number,
  err: unknown,
  reason: string,
  tx: DbTx,
): Promise<RelayForward> {
  await commerceOutboxRepo.moveToDeadLetters(row, attempts, describe(err), reason, tx);
  return { id: row.id, error: err, deadLettered: true };
}

/**
 * A failure's text for `last_error`.
 * @param err - The failure.
 * @returns Its message.
 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deliver the next due row, if any.
 * @returns The row it took and how it went, or null when none is due.
 * @throws {Error} When the outbox transaction itself fails.
 */
export async function forwardNextCommerceEvent(): Promise<RelayForward | null> {
  return db.transaction(async (tx) => {
    const row = await commerceOutboxRepo.claimNextDue(tx);
    if (row === null) return null;
    const config = getCommerceConfig();
    const attempts = row.attempts + 1;
    let answered: unknown;
    try {
      answered = (
        await signedCall(
          { baseUrl: env.COMMERCE_API_URL, secret: env.COMMERCE_API_SECRET, signer: PRODUCT_SIGNER },
          {
            method: "POST",
            path: `/v1/inbox/${row.id}`,
            body: { type: row.type, aggregateKey: row.aggregateKey, seq: row.seq, payload: row.payload },
            timeoutMs: config.relay_call_timeout_ms,
          },
        )
      ).body;
    } catch (err) {
      if (err instanceof SignedCallError && !isUnavailable(err)) return giveUp(row, attempts, err, "refused", tx);
      if (attempts >= config.relay_max_attempts) return giveUp(row, attempts, err, "attempts_exhausted", tx);
      const delay = nextAttemptDelaySeconds(attempts, {
        backoffBaseSeconds: config.relay_backoff_base_seconds,
        backoffMaxSeconds: config.relay_backoff_max_seconds,
      });
      await commerceOutboxRepo.markRetry(row.id, attempts, delay, describe(err), tx);
      return { id: row.id, error: err };
    }
    const answer = inboxAnswerSchema.safeParse(answered);
    if (!answer.success) return giveUp(row, attempts, new Error("unreadable inbox answer"), "permanent_failure", tx);
    if (answer.data.result === "permanent_failure") {
      return giveUp(row, attempts, new Error(`permanent_failure: ${answer.data.detail ?? "no detail"}`), "permanent_failure", tx);
    }
    await commerceOutboxRepo.markSent(row.id, tx);
    return { id: row.id };
  });
}

/**
 * Start the relay; run it only when the deployment sells through a billing service.
 * @returns A handle whose `stop()` ends the loop.
 */
export function startCommerceRelay(): RelayLoop {
  const config = getCommerceConfig();
  return startRelayLoop({
    forwardNext: forwardNextCommerceEvent,
    intervalMs: config.relay_interval_ms,
    batchSize: config.relay_batch,
    report: (event) => {
      if (event.kind === "pass_failed") logger.error({ err: event.err }, "commerce_relay_pass_failed");
      else if (event.kind === "dead_lettered") logger.error({ err: event.err, outboxId: event.id }, "commerce_outbox_dead_lettered");
      else logger.warn({ err: event.err, outboxId: event.id }, "commerce_outbox_forward_failed");
    },
  });
}
