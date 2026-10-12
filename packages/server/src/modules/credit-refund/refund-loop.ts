// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund loop (inner#1410 §7.1): a self-renewing timer in the server
 * process that resumes dispositions whose executor is gone, re-reads Stripe
 * for the ones waiting on it, and runs the daily reconcile when it is due.
 * Multiple server instances may run it at once: claims re-check under the
 * lot's lock and leases decide whose answer counts.
 */

import { db, env, logger } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { attemptsExhausted, waitedBackoffSeconds } from "@server/modules/credit-refund/backoff.js";
import { closeExhausted, executeRefund } from "@server/modules/credit-refund/executor.js";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import { transitionOperation } from "@server/modules/credit-refund/operation-transitions.js";
import { runDailyReconcile } from "@server/modules/credit-refund/reconcile.js";
import {
  markStaleRefundMailsUnknown,
  sendDueRefundMails,
  sendOperationMailsLater,
} from "@server/modules/credit-refund/refund-mail.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { StripeReadError, listRefundsForPayment } from "@server/modules/credit-refund/stripe-refunds.js";

/** Rows taken per query; the rest wait for the next query or tick. */
const BATCH = 50;

/**
 * Stripe keeps an idempotency key's result for 24 hours, so a disposition
 * that never learned its refund id cannot be resumed after that (E12).
 */
const RESULT_UNKNOWN_AFTER_MS = 24 * 3600 * 1000; // request-ttl:allow — Stripe's fixed idempotency window, not a deferred decision

/** A running loop. */
export interface RefundLoop {
  /** No further tick is scheduled; resolves once a tick in progress settles. */
  stop: () => Promise<void>;
}

/**
 * One tick: steps 1 to 4 of §7.1 in order. A step that fails is logged and
 * the next one still runs.
 * @returns Once the tick has settled.
 */
export async function runRefundLoopOnce(): Promise<void> {
  await runStep("resume_started", resumeStarted);
  await runStep("recheck_awaiting", recheckAwaiting);
  await runStep("send_mails", sendDueRefundMails);
  await runStep("stale_mails", async () => {
    await markStaleRefundMailsUnknown();
  });
  await runStep("daily_reconcile", runDailyReconcile);
}

/**
 * Start the loop when this deployment runs the internal API: every
 * disposition the API accepts is finished by it. Otherwise do nothing.
 * @returns The handle to stop it.
 */
export function startRefundLoop(): RefundLoop {
  if (!env.INTERNAL_API_ENABLED) return { stop: async () => {} };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;

  /** Run one tick, then schedule the next once it has settled. */
  const tick = (): void => {
    if (stopped) return;
    running = runRefundLoopOnce().finally(() => {
      running = null;
      if (!stopped) timer = setTimeout(tick, getCreditRefundConfig().loopIntervalSeconds * 1000);
    });
  };
  tick();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

/**
 * Run one step and log its failure.
 * @param name - The step, for the log.
 * @param step - The work.
 */
async function runStep(name: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    logger.error({ err, step: name }, "refund_loop_step_failed");
  }
}

// ── step 1 ───────────────────────────────────────────────────────────

/** Claim and resume every started disposition whose executor is gone. */
async function resumeStarted(): Promise<void> {
  for (;;) {
    let progressed = false;
    for (const candidate of await operationRepo.listClaimable(BATCH)) {
      const op = await claim(candidate);
      if (op === null) continue;
      progressed = true;
      try {
        if (attemptsExhausted(op.attemptCount, getCreditRefundConfig())) await closeExhausted(op, "loop");
        else await executeRefund(op, "loop");
        sendOperationMailsLater(op.id);
      } catch (err) {
        logger.error({ err, operationId: op.id }, "refund_loop_execute_failed");
      }
    }
    if (!progressed) return;
  }
}

/**
 * Take a candidate over under a new lease (E13).
 * @param candidate - The disposition and its lot.
 * @param candidate.id - The disposition.
 * @param candidate.lotId - Its lot.
 * @returns The disposition under the new lease, or null when another
 *   instance took it first.
 */
async function claim(candidate: { id: string; lotId: string }): Promise<CreditRefundOperation | null> {
  return db.transaction(async (tx) => {
    await creditLotRepo.lockLot(candidate.lotId, tx);
    if (!(await operationRepo.lockIfClaimable(candidate.id, tx))) return null;
    return transitionOperation(tx, { id: candidate.id }, { type: "E13", actor: "loop" });
  });
}

// ── step 2 ───────────────────────────────────────────────────────────

/** Re-read Stripe for every disposition waiting on it whose lookup is due. */
async function recheckAwaiting(): Promise<void> {
  for (const op of await operationRepo.listDueAwaiting(BATCH)) {
    try {
      await recheck(op);
    } catch (err) {
      logger.error({ err, operationId: op.id }, "refund_loop_recheck_failed");
    }
  }
}

/**
 * Copy Stripe's refunds for the disposition's payment, which re-judges it;
 * then put off its next lookup, or end the wait for a refund id that never
 * came (E12) — the deadline holds whether or not this read worked.
 * @param op - The waiting disposition.
 */
async function recheck(op: CreditRefundOperation): Promise<void> {
  let listed;
  try {
    listed = await listRefundsForPayment(op.paymentId);
  } catch (err) {
    if (!(err instanceof StripeReadError)) throw err;
    await db.transaction(async (tx) => {
      if (await endIfDeadlinePassed(tx, op.id)) return;
      await transitionOperation(tx, { id: op.id }, { type: "E16", failure: err.failure, actor: "loop" });
    });
    return;
  }
  await db.transaction(async (tx) => {
    await applyRefundSnapshot(tx, op.paymentId, listed, "loop");
    const current = (await operationRepo.findById(op.id, tx))!;
    if (current.status !== "awaiting_stripe" || (await endIfDeadlinePassed(tx, op.id))) return;
    await operationRepo.scheduleNextLook(
      op.id,
      waitedBackoffSeconds(current.firstCalledAt, getCreditRefundConfig(), Date.now()),
      tx,
    );
  });
  sendOperationMailsLater(op.id);
}

/**
 * E12: a disposition still waiting with no refund id 24 hours after its
 * first call goes to a person.
 * @param tx - The transaction.
 * @param operationId - The waiting disposition.
 * @returns True when it was ended.
 */
async function endIfDeadlinePassed(tx: DbTx, operationId: string): Promise<boolean> {
  const current = (await operationRepo.findById(operationId, tx))!;
  const firstCalledMs = current.firstCalledAt?.getTime();
  if (
    current.status !== "awaiting_stripe" ||
    current.stripeRefundId !== null ||
    firstCalledMs === undefined ||
    Date.now() - firstCalledMs < RESULT_UNKNOWN_AFTER_MS
  ) {
    return false;
  }
  await transitionOperation(tx, { id: operationId }, { type: "E12", actor: "loop" });
  return true;
}
