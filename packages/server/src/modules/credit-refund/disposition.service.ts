// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the internal API's endpoints do (inner#1410 §4.5, §5.2, §5.3, §6.5).
 *
 * Every disposition write replays a known key, then reads Stripe outside any
 * transaction and copies what it read in a transaction of its own (§6.4).
 * Then one transaction locks the key, looks it up again, locks the lot,
 * judges against the copies, and inserts the
 * disposition through `transitionOperation`, or saves a final refusal in
 * the same transaction. Refusals are emitted only after commit; Stripe
 * copies stay. The mail resend reads no Stripe state.
 */

import { db, logger } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import { isPurchased, type CreditLotEntity, type PaymentEntity } from "@breatic/shared";
import {
  assessOneShot,
  assessRefundCreate,
  assessRefundPreview,
  isInFlight,
  type AssessInput,
  type AssessResult,
  type OneShotKind,
  type OneShotResult,
  type RefundCreateKind,
} from "@server/modules/credit-refund/assess.js";
import { executeRefund } from "@server/modules/credit-refund/executor.js";
import { lookupKey, type Replay } from "@server/modules/credit-refund/idempotency.js";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation, OperationResult } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type NewOperation,
} from "@server/modules/credit-refund/operation-transitions.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import * as refundMailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import type { RefundMail, RefundMailKind } from "@server/modules/credit-refund/refund-mail.repo.js";
import { sendRefundMailLater } from "@server/modules/credit-refund/refund-mail.js";
import { followUpOperationLater } from "@server/modules/credit-refund/refund-follow-up.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import * as refusalRepo from "@server/modules/credit-refund/refusal.repo.js";
import type { RefusalRequest } from "@server/modules/credit-refund/refusal.repo.js";
import { RefundRefusal, refusalBodyOf, stripeUnavailable } from "@server/modules/credit-refund/refusal.js";
import {
  StripeReadError,
  listRefundsForPayment,
  readChargeDisputed,
} from "@server/modules/credit-refund/stripe-refunds.js";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";
import {
  isOnRefundFailureList,
  listUnresolvedFailed,
  type UnresolvedFailedRefund,
} from "@server/modules/credit-refund/unresolved.repo.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

/** A disposition as the API reports it: its columns, less the executor's lease. */
export type OperationSnapshot = Omit<CreditRefundOperation, "leaseToken">;

/** An answer and the status it goes out with: 202 while the work goes on. */
export interface Answer<T> {
  status: 200 | 202;
  body: T;
}

/** What every write request carries besides its body. */
export interface WriteRequest {
  lotId: string;
  adminId: string;
  key: string;
  hash: string;
  reason: string;
}

/** The lot and the facts the tables read, under the lot's lock. */
interface Facts {
  lot: CreditLotEntity;
  payment: PaymentEntity;
  ledgerSum: string;
  refundRequestedAt: Date | null;
  paidCents: number;
  currency: string;
  ops: CreditRefundOperation[];
  refunds: RefundCopy[];
  /** The lot's unresolved failed refunds, from the view (§5.3). */
  unresolved: UnresolvedFailedRefund[];
}

// ── preview ──────────────────────────────────────────────────────────

/**
 * The confirmation page's facts and what the operation the lot's state
 * allows would do now (§4.5). The refunds read are copied (§6.4).
 * @param lotId - The lot.
 * @returns The preview.
 */
export async function preview(lotId: string): Promise<Record<string, unknown>> {
  const { payment } = await loadTarget(lotId);
  await copyStripe(payment);
  const disputed = await readDisputed(payment);
  return db.transaction(async (tx) => {
    const lot = await creditLotRepo.lockLot(lotId, tx);
    if (lot === null) throw new RefundRefusal(404, "not_found", "lot_not_found");
    const facts = await readFacts(tx, lot, payment);
    const judged = assessRefundPreview({ ...assessFacts(facts), unresolvedFailedRefunds: facts.unresolved, disputed });
    const inFlight = facts.ops.find(isInFlight);
    return {
      lot: {
        id: facts.lot.id,
        lifecycle: facts.lot.lifecycle,
        refundRequestedAt: facts.refundRequestedAt,
        purchasedCredits: facts.lot.purchasedCredits,
        remainingCredits: facts.lot.remainingCredits,
        createdAt: facts.lot.createdAt,
      },
      payment: { id: payment.id, status: payment.status, paidCents: facts.paidCents, currency: facts.currency },
      refunds: facts.refunds.map((r) => ({
        stripeRefundId: r.stripeRefundId,
        amountCents: r.amountCents,
        status: r.status,
        pendingReason: r.pendingReason,
        madeByProduct: r.operationId !== null,
        everSucceeded: r.everSucceeded,
      })),
      operationInProgress: inFlight ? snapshotOf(inFlight) : null,
      unresolvedFailedRefunds: facts.unresolved.map((r) => ({
        stripeRefundId: r.stripeRefundId,
        amountCents: r.amountCents,
      })),
      disputed,
      refundFailure: await isOnRefundFailureList(lot.id, tx),
      restoreCredits: oneShotAnswerOf(judged.restoreCredits),
      oneShot: Object.fromEntries(Object.entries(judged.oneShot).map(([kind, verdict]) => [kind, oneShotAnswerOf(verdict)])),
      action:
        judged.kind === null
          ? null
          : judged.result.outcome === "create_refund"
            ? { kind: judged.kind, outcome: "create_refund", amountCents: judged.result.amountCents }
            : { kind: judged.kind, ...judged.result },
    };
  });
}

/**
 * What the preview reports about a one-shot action.
 * @param verdict - The one-shot rule's answer.
 * @returns `allowed`, or `blocked` with the code (and Stripe reason) the endpoint would answer.
 */
function oneShotAnswerOf(verdict: OneShotResult): Record<string, unknown> {
  return verdict.outcome === "proceed" ? { outcome: "allowed" } : verdict;
}

// ── approve, retry ───────────────────────────────────────────────────

/**
 * Approve or retry (§5.2): phase 1 here, then phases 2 and 3.
 * @param kind - Which of the two.
 * @param req - The request.
 * @param body - What the confirmation page sent back.
 * @param body.confirmedRefundIds - The external refunds shown.
 * @returns The disposition: 200 when finished, 202 while Stripe has not decided.
 */
export async function requestRefund(
  kind: RefundCreateKind,
  req: WriteRequest,
  body: { confirmedRefundIds?: string[] },
): Promise<Answer<unknown>> {
  const outcome = await decide(kind, req, (facts) => {
    const verdict = assessRefundCreate({
      kind,
      ...assessFacts(facts),
      confirmedRefundIds: body.confirmedRefundIds ?? [],
    });
    if (verdict.outcome === "blocked") return refusalOf(verdict);
    return { ...newOperation(kind, req, facts.payment), confirmedRefundIds: body.confirmedRefundIds };
  });
  if ("replay" in outcome) return answerReplay(outcome.replay);
  await executeRefund(outcome.op, "request");
  return answerOperation((await operationRepo.findById(outcome.op.id))!);
}

// ── reject, settle, send_back, resolve_outside, restore_credits ──────

/**
 * A disposition that finishes in its request (§5.3). Restoring credits also
 * reads whether the charge is disputed, after the refunds are copied.
 * @param kind - Which of the five.
 * @param req - The request.
 * @param body - The kind's own fields.
 * @param body.notify - settle: whether to tell the buyer.
 * @param body.confirmedSucceededCents - settle, resolve_outside: the succeeded sum the operator saw.
 * @param body.failedRefundIds - resolve_outside, restore_credits: the refunds answered for.
 * @returns The finished disposition.
 */
export async function requestOneShot(
  kind: OneShotKind,
  req: WriteRequest,
  body: { notify?: boolean; confirmedSucceededCents?: number; failedRefundIds?: string[] },
): Promise<Answer<unknown>> {
  const outcome = await decide(kind, req, (facts, disputed) => {
    const verdict = assessOneShot({
      kind,
      ...assessFacts(facts),
      paidCents: facts.paidCents,
      unresolvedFailedRefunds: facts.unresolved,
      disputed,
      ...body,
    });
    if (verdict.outcome === "blocked") return refusalOf(verdict);
    return { ...newOperation(kind, req, facts.payment), ...body };
  }, { readDisputed: kind === "restore_credits" });
  if ("replay" in outcome) return answerReplay(outcome.replay);
  followUpOperationLater(outcome.op.id);
  return answerOperation(outcome.op);
}

/**
 * Prepare Stripe facts outside the key lock, then commit a disposition or
 * final refusal through the common key decision transaction.
 * @param kind - The requested disposition.
 * @param req - Original request identity.
 * @param judge - Pure judgement made before any business write.
 * @param options - Additional external reads.
 * @param options.readDisputed - Whether to read the charge's disputed flag.
 * @returns A replay or newly committed disposition.
 * @throws {RefundRefusal} A key conflict or failed external read.
 */
async function decide(
  kind: NewOperation["kind"],
  req: WriteRequest,
  judge: (facts: Facts, disputed: boolean) => NewOperation | RefundRefusal,
  { readDisputed: wantsDisputed = false }: { readDisputed?: boolean } = {},
): Promise<{ replay: Replay } | { op: CreditRefundOperation }> {
  const identity: RefusalRequest = { ...req, requestKind: kind, targetKind: "lot", targetId: req.lotId };
  const replay = await lookupKey(req.key, req.hash);
  if (replay) return { replay };
  let target = await findTarget(req.lotId);
  if (target === null) {
    const rechecked = await withKeyDecision(identity, async (tx) =>
      (await findTarget(req.lotId, tx)) ?? new RefundRefusal(404, "not_found", "lot_not_found"));
    if ("replay" in rechecked) return rechecked;
    target = rechecked.value;
  }
  const { payment } = target;
  await copyStripe(payment);
  const disputed = wantsDisputed ? await readDisputed(payment) : false;
  const decided = await withKeyDecision(identity, async (tx) => {
    const current = await findTarget(req.lotId, tx);
    if (current === null) return new RefundRefusal(404, "not_found", "lot_not_found");
    const create = judge(await readFacts(tx, current.lot, current.payment), disputed);
    if (create instanceof RefundRefusal) return create;
    const op = await transitionOperation(tx, null, { type: "E1", create, actor: "request" });
    return { op: op! };
  });
  return "replay" in decided ? decided : decided.value;
}

/**
 * Serialize all eight writes in their shared key namespace. The callback
 * returns a refusal before business writes; SQL failures always roll back.
 * @param req - The original identity to persist for a refusal.
 * @param decideValue - A transaction-local judgement and optional business write.
 * @returns The committed value or a saved result to replay after commit.
 * @throws {RefundRefusal} Key reuse or a currently executing original request.
 */
async function withKeyDecision<T>(
  req: RefusalRequest,
  decideValue: (tx: DbTx) => Promise<T | RefundRefusal>,
): Promise<{ value: T } | { replay: Replay }> {
  return db.transaction(async (tx) => {
    await operationRepo.lockIdempotencyKey(req.key, tx);
    const replay = await lookupKey(req.key, req.hash, tx);
    if (replay) return { replay };
    const value = await decideValue(tx);
    if (value instanceof RefundRefusal) {
      if (value.status !== 404 && value.status !== 409) throw value;
      const refusal = await refusalRepo.insert(req, value.status, refusalBodyOf(value), tx);
      return { replay: { kind: "refusal", refusal } };
    }
    return { value };
  });
}

/**
 * Step 0: read every refund Stripe holds for the payment and copy it in its
 * own transaction, which may finish a disposition waiting on Stripe; that
 * disposition's buyer mail goes out once it has committed.
 * @param payment - The payment.
 * @throws {RefundRefusal} 503 `stripe_unavailable` when the read fails.
 */
async function copyStripe(payment: PaymentEntity): Promise<void> {
  const listed = await readStripe(payment, () => listRefundsForPayment(payment.id));
  const rejudged = await db.transaction((tx) => applyRefundSnapshot(tx, payment.id, listed, "request"));
  if (rejudged !== null) followUpOperationLater(rejudged);
}

/**
 * Whether Stripe holds the payment's charge as disputed (§5.3), read after
 * the refunds were copied; a failure keeps those copies (§6.4).
 * @param payment - The payment.
 * @returns True when disputed.
 * @throws {RefundRefusal} 503 `stripe_unavailable` when the read fails.
 */
function readDisputed(payment: PaymentEntity): Promise<boolean> {
  return readStripe(payment, () => readChargeDisputed(payment.stripePaymentIntentId));
}

/**
 * One read of the payment on Stripe; a failed read is logged and answers 503.
 * @param payment - The payment the read is about.
 * @param read - The read.
 * @returns What the read returned.
 * @throws {RefundRefusal} 503 `stripe_unavailable` when the read fails.
 */
async function readStripe<T>(payment: PaymentEntity, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof StripeReadError) {
      // err keeps the stack and cause chain; failure keeps Stripe's own error type.
      logger.error({ err, failure: err.failure, paymentId: payment.id }, "credit_refund_stripe_read_failed");
      throw stripeUnavailable();
    }
    throw err;
  }
}

// ── mail resend ──────────────────────────────────────────────────────

/** The buyer mail each finished result sends (§6.5); the rest send none. */
const MAIL_KIND: Partial<Record<OperationResult, RefundMailKind>> = {
  refunded: "refund_completed",
  rejected: "refund_rejected",
  restored: "refund_restored",
};

/**
 * Queue another buyer email for a finished disposition (§6.5).
 * @param req - The request, naming the disposition instead of a lot.
 * @param req.operationId - The disposition.
 * @returns The new outbox row: 202 while it has not been sent.
 */
export async function resendMail(
  req: Omit<WriteRequest, "lotId"> & { operationId: string },
): Promise<Answer<unknown>> {
  const replay = await lookupKey(req.key, req.hash);
  if (replay) return answerReplay(replay);
  const identity: RefusalRequest = {
    ...req, requestKind: "resend_mail", targetKind: "operation", targetId: req.operationId,
  };
  let op = await operationRepo.findById(req.operationId);
  if (op === null) {
    const rechecked = await withKeyDecision(identity, async (tx) =>
      (await operationRepo.findById(req.operationId, tx)) ?? new RefundRefusal(404, "not_found", "operation_not_found"));
    if ("replay" in rechecked) return answerReplay(rechecked.replay);
    op = rechecked.value;
  }
  const original = op;
  const outcome = await withKeyDecision(identity, async (tx) => {
    const lot = await creditLotRepo.lockLot(original.lotId, tx);
    if (lot === null) return new RefundRefusal(404, "not_found", "lot_not_found");
    const current = await operationRepo.lockById(original.id, tx);
    if (current === null) return new RefundRefusal(404, "not_found", "operation_not_found");
    const kind = current.result === null ? undefined : MAIL_KIND[current.result];
    if (kind === undefined) return new RefundRefusal(409, "mail_not_resendable", "mail_not_resendable");
    return refundMailRepo.insertResend({
      operationId: current.id,
      kind,
      requestedBy: req.adminId,
      reason: req.reason,
      idempotencyKey: req.key,
      requestHash: req.hash,
    }, tx);
  });
  if ("replay" in outcome) return answerReplay(outcome.replay);
  sendRefundMailLater(outcome.value.id);
  return answerMail(outcome.value);
}

// ── shared steps ─────────────────────────────────────────────────────

/**
 * The lot a request names and the payment it came from.
 * @param lotId - The lot.
 * @returns Both.
 * @throws {RefundRefusal} 404 when there is no such lot, or nobody paid for it.
 */
async function loadTarget(lotId: string): Promise<{ lot: CreditLotEntity; payment: PaymentEntity }> {
  const target = await findTarget(lotId);
  if (target === null) throw new RefundRefusal(404, "not_found", "lot_not_found");
  return target;
}

/**
 * Read a live purchased lot and payment, locking the live target inside a
 * key decision. Preparation and final judgement share this availability rule.
 * @param lotId - The logical target.
 * @param tx - The key decision transaction, if present.
 * @returns The target or null when the lot is soft-deleted or either record is absent.
 */
async function findTarget(
  lotId: string,
  tx?: DbTx,
): Promise<{ lot: CreditLotEntity; payment: PaymentEntity } | null> {
  const lot = tx ? await creditLotRepo.lockLiveLot(lotId, tx) : await creditLotRepo.findLotById(lotId);
  const payment = lot && isPurchased(lot.sourceKind) ? await paymentRepo.getPaymentById(lot.sourceId, tx) : null;
  return lot && payment ? { lot, payment } : null;
}

/**
 * The facts the tables read, inside the transaction holding the lot's lock.
 * @param tx - The transaction.
 * @param lot - The lot, locked by this transaction.
 * @param payment - Its payment.
 * @returns The facts.
 */
async function readFacts(tx: DbTx, lot: CreditLotEntity, payment: PaymentEntity): Promise<Facts> {
  const { ledgerSum, refundRequestedAt } = await creditLotRepo.readRefundFacts(lot.id, tx);
  const paid = (await paymentRepo.readPaidAmount(payment.id, tx))!;
  return {
    lot,
    payment,
    ledgerSum,
    refundRequestedAt,
    paidCents: paid.paidCents,
    currency: paid.currency,
    ops: await operationRepo.listForLot(lot.id, tx),
    refunds: await refundCopyRepo.listForPayment(payment.id, tx),
    unresolved: await listUnresolvedFailed(lot.id, tx),
  };
}

/**
 * The facts in the judgement table's shape.
 * @param facts - The facts.
 * @returns The table's input, less the request's fields.
 */
function assessFacts(facts: Facts): Pick<AssessInput, "lot" | "payment" | "ops" | "refunds"> {
  const { payment } = facts;
  return {
    lot: {
      lifecycle: facts.lot.lifecycle,
      remainingCredits: Number(facts.lot.remainingCredits),
      ledgerSum: Number(facts.ledgerSum),
    },
    payment: {
      status: payment.status,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      paidCents: facts.paidCents,
    },
    ops: facts.ops,
    refunds: facts.refunds,
  };
}

/**
 * The columns every new disposition takes from its request.
 * @param kind - Its kind.
 * @param req - The request.
 * @param payment - The payment it refunds.
 * @returns The common part of E1.
 */
function newOperation(
  kind: NewOperation["kind"],
  req: WriteRequest,
  payment: PaymentEntity,
): NewOperation {
  return {
    kind,
    lotId: req.lotId,
    paymentId: payment.id,
    idempotencyKey: req.key,
    requestHash: req.hash,
    requestedBy: req.adminId,
    reason: req.reason,
  };
}

/**
 * The 409 a judgement table's refusal answers with.
 * @param verdict - The refusal.
 * @returns The error to throw.
 */
function refusalOf(verdict: Extract<AssessResult, { outcome: "blocked" }>): RefundRefusal {
  return verdict.code === "stripe_blocks"
    ? new RefundRefusal(409, "stripe_blocks", "stripe_blocks", verdict.reason)
    : new RefundRefusal(409, verdict.code, verdict.code);
}

/**
 * A disposition as the API reports it.
 * @param op - A disposition.
 * @returns Its snapshot.
 */
function snapshotOf(op: CreditRefundOperation): OperationSnapshot {
  const { leaseToken: _lease, ...snapshot } = op;
  return snapshot;
}

/**
 * The answer for a disposition.
 * @param op - A disposition.
 * @returns Its snapshot, 202 while it is still in flight.
 */
function answerOperation(op: CreditRefundOperation): Answer<OperationSnapshot> {
  return { status: isInFlight(op) ? 202 : 200, body: snapshotOf(op) };
}

/**
 * The answer for an outbox row.
 * @param mail - An outbox row.
 * @returns It, 202 while it has not been sent.
 */
function answerMail(mail: RefundMail): Answer<RefundMail> {
  const waiting = mail.status === "pending" || mail.status === "sending";
  return { status: waiting ? 202 : 200, body: mail };
}

/**
 * The answer for a repeated request.
 * @param replay - What an earlier request under the same key left.
 * @returns Its current snapshot, or the literal committed refusal.
 * @throws {RefundRefusal} The original committed refusal after the transaction finishes.
 */
function answerReplay(replay: Replay): Answer<unknown> {
  if (replay.kind === "refusal") {
    const { responseStatus, responseBody } = replay.refusal;
    throw new RefundRefusal(responseStatus, responseBody.code, undefined, responseBody.reason, responseBody);
  }
  return replay.kind === "operation" ? answerOperation(replay.op) : answerMail(replay.mail);
}
