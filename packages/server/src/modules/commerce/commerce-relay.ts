// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sends the product's outbox to the billing service (inner#1993 §3.4, §5.2).
 * Each row is claimed in a transaction of its own and delivered, signed as
 * `product`, while the row is held: an answered row is marked sent; a
 * permanent failure or a refusal moves it to the dead letters; an unavailable
 * billing service puts it back with a backoff until `relay_max_attempts`.
 *
 * Whoever commits a row in this process calls {@link wakeCommerceRelay}
 * after the commit, so the row goes out at once; the relay's interval only
 * catches retries that came due and rows other processes wrote. A user's
 * request waiting on a referral binding sends it itself through
 * {@link sendPendingReferralBinding}; the relay alone counts attempts.
 */

import {
  SignedCallError,
  commerceOutboxRepo,
  db,
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
import { billingUnavailable, commerceTarget } from "@server/modules/commerce/commerce-client.js";

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
    return row === null ? null : deliverRow(row, tx);
  });
}

/** How the billing service's inbox took one delivery. */
type InboxOutcome =
  | { kind: "sent" }
  | { kind: "dead"; reason: "refused" | "permanent_failure"; err: unknown }
  | { kind: "unavailable"; err: unknown };

/**
 * Send one row to the billing service's inbox under its own delivery id and
 * read the answer: applied or duplicate is sent; a refusal, an unreadable
 * answer or `permanent_failure` is given up; anything else is unavailable.
 * @param row - The row.
 * @param timeoutMs - How long the call may take.
 * @returns How it went.
 */
async function sendToInbox(row: commerceOutboxRepo.CommerceOutboxRow, timeoutMs: number): Promise<InboxOutcome> {
  let answered: unknown;
  try {
    answered = (
      await signedCall(commerceTarget(), {
        method: "POST",
        path: `/v1/inbox/${row.id}`,
        body: { type: row.type, aggregateKey: row.aggregateKey, seq: row.seq, payload: row.payload },
        timeoutMs,
      })
    ).body;
  } catch (err) {
    if (err instanceof SignedCallError && !isUnavailable(err)) return { kind: "dead", reason: "refused", err };
    return { kind: "unavailable", err };
  }
  const answer = inboxAnswerSchema.safeParse(answered);
  if (!answer.success) return { kind: "dead", reason: "permanent_failure", err: new Error("unreadable inbox answer") };
  if (answer.data.result === "permanent_failure") {
    return { kind: "dead", reason: "permanent_failure", err: new Error(`permanent_failure: ${answer.data.detail ?? "no detail"}`) };
  }
  return { kind: "sent" };
}

/**
 * Deliver one claimed row and record how it went.
 * @param row - The row, held by `tx`.
 * @param tx - The transaction holding it.
 * @returns How it went: sent, put back with its error, or dead-lettered.
 * @throws {Error} When the outbox write itself fails.
 */
async function deliverRow(row: commerceOutboxRepo.CommerceOutboxRow, tx: DbTx): Promise<RelayForward> {
  const config = getCommerceConfig();
  const attempts = row.attempts + 1;
  const outcome = await sendToInbox(row, config.relay_call_timeout_ms);
  if (outcome.kind === "sent") {
    await commerceOutboxRepo.markSent(row.id, tx);
    return { id: row.id };
  }
  if (outcome.kind === "dead") return giveUp(row, attempts, outcome.err, outcome.reason, tx);
  if (attempts >= config.relay_max_attempts) return giveUp(row, attempts, outcome.err, "attempts_exhausted", tx);
  const delay = nextAttemptDelaySeconds(attempts, {
    backoffBaseSeconds: config.relay_backoff_base_seconds,
    backoffMaxSeconds: config.relay_backoff_max_seconds,
  });
  await commerceOutboxRepo.markRetry(row.id, attempts, delay, describe(outcome.err), tx);
  return { id: row.id, error: outcome.err };
}

/**
 * Send an account's pending referral binding to the inbox now, before a
 * membership checkout or a later binding that depends on it (inner#1993 §5.5,
 * §8.4). The row is read without a lock and sent once under its own
 * delivery id, regardless of its backoff; the inbox applies an id once, so a
 * relay sending it at the same moment is harmless. A definite answer is
 * recorded as the relay records it, without counting an attempt: sent, or
 * moved to the dead letters (the binding is then not made and the caller
 * goes on). An unavailable billing service leaves the row exactly as it was
 * for the relay.
 * @param userId - The account.
 * @returns Once no unsent binding is left: sent, dead-lettered, or none there.
 * @throws {UnavailableError} 503 `billing_unavailable` when the inbox could not be reached.
 */
export async function sendPendingReferralBinding(userId: string): Promise<void> {
  const row = await commerceOutboxRepo.findUnsentReferralBinding(userId);
  if (row === null) return;
  const outcome = await sendToInbox(row, getCommerceConfig().quick_call_timeout_ms);
  if (outcome.kind === "unavailable") {
    logger.error({ err: outcome.err, outboxId: row.id, userId }, "commerce_call_unavailable");
    throw billingUnavailable();
  }
  if (outcome.kind === "sent") {
    await db.transaction((tx) => commerceOutboxRepo.markSent(row.id, tx));
    return;
  }
  const { err, reason } = outcome;
  const moved = await db.transaction((tx) => commerceOutboxRepo.moveToDeadLetters(row, row.attempts, describe(err), reason, tx));
  if (moved) logger.error({ err, outboxId: row.id }, "commerce_outbox_dead_lettered");
}

/** The relay this process started, if any. */
let running: RelayLoop | null = null;

/**
 * Start the relay; run it only when the deployment sells through a billing service.
 * @returns A handle whose `stop()` ends the loop.
 */
export function startCommerceRelay(): RelayLoop {
  const config = getCommerceConfig();
  running = startRelayLoop({
    forwardNext: forwardNextCommerceEvent,
    intervalMs: config.relay_interval_ms,
    batchSize: config.relay_batch,
    // A failed row is backed off, so the pass goes on to other aggregates (§5.2).
    continueAfterRetry: true,
    report: (event) => {
      if (event.kind === "pass_failed") logger.error({ err: event.err }, "commerce_relay_pass_failed");
      else if (event.kind === "dead_lettered") logger.error({ err: event.err, outboxId: event.id }, "commerce_outbox_dead_lettered");
      else logger.warn({ err: event.err, outboxId: event.id }, "commerce_outbox_forward_failed");
    },
  });
  return running;
}

/**
 * Tell this process's relay that a row was committed, so it sends it now.
 * Call it only after the transaction that appended the row has committed; it
 * does nothing where no relay runs (nothing sold, or a process without one).
 */
export function wakeCommerceRelay(): void {
  running?.wake();
}
