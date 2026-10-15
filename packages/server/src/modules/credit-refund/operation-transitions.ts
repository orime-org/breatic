// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The disposition state machine (inner#1410 §6.2): the one writer of
 * `credit_refund_operations` and its event rows.
 *
 * Every call runs in the caller's transaction and takes the locks in the
 * §9 order: the lot first, then the disposition row. Each cell of the table
 * that does not refuse appends exactly one event row, including the cells
 * that leave the status where it was; an impossible cell throws
 * {@link ImpossibleTransitionError} before writing anything.
 */

import type { DbTx } from "@breatic/core";
import type { CreditLotEntity } from "@breatic/shared";
import { creditLotRepo, creditLotService } from "@breatic/domain";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { nextAttemptDelaySeconds, waitedBackoffSeconds } from "@server/modules/credit-refund/backoff.js";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type {
  AttentionReason,
  CreditRefundOperation,
  OperationKind,
  OperationPatch,
  OperationResult,
  OperationStatus,
} from "@server/modules/credit-refund/operation.repo.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import * as refundMailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import { succeededCents } from "@server/modules/credit-refund/settle-rule.js";
import { isStripeRefusal, type StoredCreateAnswer } from "@server/modules/credit-refund/stripe-answer.js";
import { listUnresolvedFailed } from "@server/modules/credit-refund/unresolved.repo.js";
import type { RefundCopy, StripeRefundObject } from "@server/modules/credit-refund/types.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";
import { randomUUID } from "node:crypto";

export type {
  CreditRefundOperation,
  OperationKind,
  OperationStatus,
} from "@server/modules/credit-refund/operation.repo.js";

/** A failed Stripe call, as the executor caught it. */
export interface StripeFailure {
  message: string;
  httpStatus?: number;
  type?: string;
  code?: string;
  shouldRetry?: boolean;
}

/** What an E1 request carries into the new row. */
export interface NewOperation {
  kind: OperationKind;
  lotId: string;
  paymentId: string;
  idempotencyKey: string;
  requestHash: string;
  requestedBy: string;
  reason: string;
  /** Read for settle only; fixed for the other kinds. */
  notify?: boolean;
  confirmedRefundIds?: string[];
  confirmedSucceededCents?: number;
  failedRefundIds?: string[];
}

/** Who wrote an event row (§5.1 `detail.actor`). */
export type Actor = "request" | "loop" | "webhook" | "reconcile";

/** A refund object Stripe answered with. */
interface RefundEvent {
  type: "E2" | "E3" | "E5";
  refund: StripeRefundObject;
}

/** Stripe did not refund: a failed or canceled refund, or a definite refusal. */
interface DeclineEvent {
  type: "E6";
  refund?: StripeRefundObject;
  failure?: StripeFailure;
}

/** Who made an event and under which lease (§5.1 `detail.actor`, §7.1). */
interface EventMeta {
  /**
   * The lease an executor attempt's answer was made under, whoever runs it;
   * absent for events no attempt answers (claims, rechecks, deadlines,
   * webhook, reconcile and request reads).
   */
  leaseToken?: string;
  actor: Actor;
}

/** An event with who made it. */
type Made<E> = E & EventMeta;

/** The events of §6.2, as the code that observes them builds them. */
export type OperationEventBody =
  | { type: "E1"; create: NewOperation }
  | RefundEvent
  | {
      type: "E4";
      refund: StripeRefundObject;
      reason: "partial_refund" | "unexpected_external_refund";
    }
  | DeclineEvent
  | { type: "E7" | "E8" | "E9" | "E17"; failure: StripeFailure }
  /** `createFailure`: the create's error, when the read after it failed. */
  | { type: "E16"; failure: StripeFailure; createFailure?: StripeFailure }
  | { type: "E10" | "E11" | "E12" | "E13" }
  | { type: "E14"; closedBy: string };

/**
 * An event as `transitionOperation` executes it. E15 is any event whose
 * lease the row no longer holds.
 */
export type OperationEvent = Made<OperationEventBody>;

/** A cell of §6.2 that cannot happen. */
export class ImpossibleTransitionError extends Error {
  readonly from: OperationStatus | null;
  readonly event: OperationEvent["type"];

  /**
   * Name the cell refused.
   * @param from - The status found, null for no row.
   * @param event - The event refused.
   */
  constructor(from: OperationStatus | null, event: OperationEvent["type"]) {
    super(`No refund disposition transition from ${from ?? "(no row)"} on ${event}`);
    this.name = "ImpossibleTransitionError";
    this.from = from;
    this.event = event;
  }
}

/** The `event` column each event writes. */
const EVENT_NAME: Record<OperationEvent["type"], string> = {
  E1: "requested",
  E2: "refund_succeeded",
  E3: "refund_succeeded_others_pending",
  E4: "refund_succeeded_unsettleable",
  E5: "refund_pending",
  E6: "refund_declined",
  E7: "retryable_error",
  E8: "stripe_server_error",
  E9: "charge_already_refunded",
  E10: "refund_not_found",
  E11: "attempts_exhausted",
  E12: "deadline_reached",
  E13: "claimed",
  E14: "attention_closed",
  E16: "stripe_read_failed",
  E17: "unclassified_error",
};

/** `notify` for the kinds whose request does not choose it (§5.1). */
const FIXED_NOTIFY: Partial<Record<OperationKind, boolean>> = {
  approve: true,
  retry: true,
  reject: true,
  send_back: false,
  resolve_outside: false,
  restore_credits: true,
};

/** The row being moved, under the locks the call took. */
interface Ctx {
  tx: DbTx;
  lot: CreditLotEntity;
  row: CreditRefundOperation;
  /** Who is moving it; the rows it writes for other dispositions say the same. */
  actor: Actor;
}

/** What a finished disposition tells the buyer. */
type Tell =
  | { kind: "refund_completed"; amountCents: number }
  | { kind: "refund_rejected" }
  | { kind: "refund_restored" };

/** A finish to `succeeded`. */
interface Finish {
  result: OperationResult;
  patch?: OperationPatch;
  /** Failed refunds this disposition answers for. */
  resolve?: readonly string[];
  tell?: Tell | null;
}

/**
 * Execute one cell of the disposition table.
 * @param tx - The caller's transaction.
 * @param op - The disposition to move (re-read under lock), or null for none.
 * @param event - What happened.
 * @returns The disposition after the cell; null for E14 with no row.
 * @throws {ImpossibleTransitionError} When the cell cannot happen; nothing is written.
 */
export async function transitionOperation(
  tx: DbTx,
  op: { id: string } | null,
  event: OperationEvent,
): Promise<CreditRefundOperation | null> {
  if (op === null) {
    if (event.type === "E1") return create(tx, event);
    if (event.type === "E14") return null;
    throw new ImpossibleTransitionError(null, event.type);
  }
  const lotId = await operationRepo.findLotId(op.id, tx);
  const lot = lotId === null ? null : await creditLotRepo.lockLot(lotId, tx);
  const row = lot === null ? null : await operationRepo.lockById(op.id, tx);
  if (lot === null || row === null) throw new ImpossibleTransitionError(null, event.type);
  const ctx = { tx, lot, row, actor: event.actor };

  if ("leaseToken" in event && event.leaseToken !== undefined && event.leaseToken !== row.leaseToken) {
    return move(ctx, "late_answer", {}, { answer: event.type, ...detailOf(event) });
  }
  switch (row.status) {
    case "started":
      return fromStarted(ctx, event);
    case "awaiting_stripe":
      return fromAwaiting(ctx, event);
    case "succeeded":
    case "needs_attention":
      return fromFinished(ctx, event);
  }
}

// ── (no row) × E1 ────────────────────────────────────────────────────

/**
 * Insert the disposition and do what its kind does at once (§5.2, §5.3).
 * @param tx - The caller's transaction.
 * @param event - The E1 event: the request and who made it.
 * @returns The new row.
 */
async function create(
  tx: DbTx,
  event: Extract<OperationEvent, { type: "E1" }>,
): Promise<CreditRefundOperation> {
  const req = event.create;
  const lot = await creditLotRepo.lockLot(req.lotId, tx);
  if (lot === null) throw new ImpossibleTransitionError(null, "E1");
  const startsRefund = req.kind === "approve" || req.kind === "retry";
  const { refundRequestedAt } = await creditLotRepo.readRefundFacts(req.lotId, tx);
  if (req.kind === "approve") await creditLotService.markRefunding({ lotId: req.lotId }, tx);

  const copies = startsRefund ? [] : await refundCopyRepo.listForPayment(req.paymentId, tx);
  const finishing = finishingValues(req, lot, copies);
  const row = await operationRepo.insert(
    {
      lotId: req.lotId,
      paymentId: req.paymentId,
      kind: req.kind,
      status: startsRefund ? "started" : "succeeded",
      result: finishing?.result ?? null,
      idempotencyKey: req.idempotencyKey,
      requestHash: req.requestHash,
      requestedBy: req.requestedBy,
      reason: req.reason,
      notify: FIXED_NOTIFY[req.kind] ?? req.notify ?? false,
      refundRequestedAt,
      confirmedRefundIds: req.confirmedRefundIds ?? [],
      confirmedSucceededCents: req.confirmedSucceededCents ?? null,
      failedRefundIds: req.failedRefundIds ?? [],
      settledSucceededCents: finishing?.settledCents ?? null,
      lease: startsRefund ? { token: randomUUID(), seconds: getCreditRefundConfig().leaseSeconds } : null,
      finished: !startsRefund,
    },
    tx,
  );
  await operationRepo.appendEvent(
    {
      operationId: row.id,
      event: EVENT_NAME.E1,
      fromStatus: null,
      toStatus: row.status,
      detail: detailOf(event),
    },
    tx,
  );
  if (startsRefund) return row;

  // Read before booking: once the lot is refunded the view counts only
  // refunds that had succeeded, and booking answers for every one (§5.5).
  const answered =
    req.kind === "resolve_outside" || req.kind === "restore_credits"
      ? row.failedRefundIds
      : finishing!.books
        ? await unresolvedIds(tx, req.lotId)
        : [];
  if (req.kind === "reject") {
    await creditLotService.rejectRefund({ lotId: req.lotId, operationId: row.id }, tx);
  } else if (req.kind === "send_back") {
    await creditLotService.sendBackRefund({ lotId: req.lotId }, tx);
  } else if (req.kind === "restore_credits") {
    await creditLotService.restoreRefundedCredits({ lotId: req.lotId, operationId: row.id }, tx);
  } else if (finishing!.books) {
    // settle, and resolve_outside on a lot not yet booked (§5.3, §5.5).
    await creditLotService.settleRefund({ lotId: req.lotId, refundId: finishing!.bookOn ?? row.id }, tx);
  }
  await afterSucceeded({ tx, lot, row, actor: event.actor }, row, {
    result: row.result!,
    resolve: answered,
    tell:
      req.kind === "reject"
        ? { kind: "refund_rejected" }
        : req.kind === "restore_credits"
          ? { kind: "refund_restored" }
          : req.kind === "settle" && row.notify
            ? { kind: "refund_completed", amountCents: finishing!.settledCents! }
            : null,
  });
  return row;
}

/**
 * The result of a kind that finishes in its request; for the two that book
 * the lot, the refund the ledger row names and the succeeded sum (§5.5).
 * @param req - The request.
 * @param lot - The locked lot.
 * @param copies - The payment's refund copies, as this request wrote them.
 * @returns The values, or null for a kind that starts a refund.
 * @throws {Error} When settle finds no succeeded refund to book on.
 */
function finishingValues(
  req: NewOperation,
  lot: CreditLotEntity,
  copies: readonly RefundCopy[],
): { result: OperationResult; books: boolean; bookOn?: string; settledCents?: number } | null {
  const succeeded = copies
    .filter((c) => c.status === "succeeded")
    .sort((a, b) => b.amountCents - a.amountCents);
  const settledCents = succeededCents(copies);
  switch (req.kind) {
    case "reject":
      return { result: "rejected", books: false };
    case "send_back":
      return { result: "sent_back", books: false };
    case "restore_credits":
      return { result: "restored", books: false };
    case "resolve_outside":
      // A booked lot only has failed refunds answered for; one not yet
      // booked is booked here, on the largest succeeded refund if any.
      return lot.lifecycle === "refunded"
        ? { result: "resolved_outside", books: false }
        : {
            result: "resolved_outside",
            books: true,
            ...(succeeded[0] && { bookOn: succeeded[0].stripeRefundId }),
            settledCents,
          };
    case "settle": {
      // The product's own succeeded refund, otherwise the largest.
      const bookOn = succeeded.find((c) => c.operationId !== null) ?? succeeded[0];
      if (bookOn === undefined) throw new Error("settle requires a succeeded refund to book on");
      return { result: "refunded", books: true, bookOn: bookOn.stripeRefundId, settledCents };
    }
    default:
      return null;
  }
}

/**
 * The failed refunds a booking answers for: every one unanswered at the
 * moment the lot is booked (§5.5), by the one definition (§5.3). Read before
 * the lot moves to `refunded`.
 * @param tx - The caller's transaction.
 * @param lotId - The lot about to be booked.
 * @returns Their Stripe ids.
 */
async function unresolvedIds(tx: DbTx, lotId: string): Promise<string[]> {
  return (await listUnresolvedFailed(lotId, tx)).map((c) => c.stripeRefundId);
}

/**
 * Whether the declined refund had succeeded before, by its copy.
 * @param ctx - The locked row.
 * @param event - The E6 event.
 * @returns True when the copy says it once succeeded.
 */
async function everSucceeded(ctx: Ctx, event: Made<DeclineEvent>): Promise<boolean> {
  if (!event.refund) return false;
  const copies = await refundCopyRepo.listForPayment(ctx.row.paymentId, ctx.tx);
  return copies.some((c) => c.stripeRefundId === event.refund!.id && c.everSucceeded);
}

// ── started ──────────────────────────────────────────────────────────

/**
 * The `started` line.
 * @param ctx - The locked row.
 * @param event - The event.
 * @returns The row after.
 */
async function fromStarted(ctx: Ctx, event: OperationEvent): Promise<CreditRefundOperation> {
  switch (event.type) {
    case "E2":
      return book(ctx, event);
    case "E3":
    case "E5":
      return toAwaiting(ctx, event, { stripeRefundId: event.refund.id });
    case "E4":
      return toAttention(ctx, event, event.reason, null, { stripeRefundId: event.refund.id });
    case "E6":
      // A person decides and the lot stays refunding (§6.2): money that went
      // out and came back, a request Stripe never executed, or a refusal.
      return toAttention(ctx, event, await declineReason(ctx, event), answerText(detailOf(event)), {
        ...refundIdOf(event),
        ...(event.failure && { lastError: event.failure.message }),
      });
    case "E7":
    case "E16":
    case "E17": {
      // The attempt is over: its lease ends now, so a same-key repeat replays
      // and the loop claims the row once it is due (§4.6). A failed read
      // stays in the event row; last_error keeps the create's error (§5.1).
      const attemptCount = ctx.row.attemptCount + 1;
      const createError = event.type === "E16" ? event.createFailure : event.failure;
      return move(ctx, EVENT_NAME[event.type], {
        attemptCount,
        ...(createError && { lastError: createError.message }),
        lease: { token: ctx.row.leaseToken!, seconds: 0 },
        nextAttemptInSeconds: nextAttemptDelaySeconds(attemptCount, getCreditRefundConfig()),
      }, detailOf(event));
    }
    case "E8":
      return toAwaiting(ctx, event, { lastError: event.failure.message });
    case "E9":
      return toAttention(ctx, event, "already_refunded_elsewhere", firstLine(event.failure.message), {
        lastError: event.failure.message,
      });
    case "E11": {
      const { reason, detail } = await exhaustedAttention(ctx);
      return toAttention(ctx, event, reason, detail);
    }
    case "E12":
      return move(ctx, EVENT_NAME.E12, {}, detailOf(event));
    case "E13":
      return move(ctx, EVENT_NAME.E13, {
        lease: { token: randomUUID(), seconds: getCreditRefundConfig().leaseSeconds },
      }, detailOf(event));
    default:
      break;
  }
  return impossible(ctx, event);
}

// ── awaiting_stripe ──────────────────────────────────────────────────

/**
 * The `awaiting_stripe` line: only looks Stripe up, holds no lease.
 * @param ctx - The locked row.
 * @param event - The event.
 * @returns The row after.
 */
async function fromAwaiting(ctx: Ctx, event: OperationEvent): Promise<CreditRefundOperation> {
  const known = ctx.row.stripeRefundId !== null;
  switch (event.type) {
    case "E2":
      return book(ctx, event);
    case "E3":
    case "E5":
      return move(ctx, EVENT_NAME[event.type], { stripeRefundId: event.refund.id }, detailOf(event));
    case "E4":
      return toAttention(ctx, event, event.reason, null, { stripeRefundId: event.refund.id });
    case "E6":
      return toAttention(ctx, event, "stripe_refund_failed_later", answerText(detailOf(event)), refundIdOf(event));
    case "E10":
      if (known) break;
      // Only the loop's recheck sets the next look: a preview or webhook
      // that finds nothing must not put off the 24-hour deadline (E12).
      return move(ctx, EVENT_NAME.E10, {}, detailOf(event));
    case "E12":
      return known
        ? move(ctx, EVENT_NAME.E12, {}, detailOf(event))
        : toAttention(ctx, event, "stripe_result_unknown", lastErrorLine(ctx));
    case "E13":
      return move(ctx, EVENT_NAME.E13, {}, detailOf(event));
    case "E16":
      return move(ctx, EVENT_NAME.E16, {
        nextAttemptInSeconds: waitedBackoffSeconds(ctx.row.firstCalledAt, getCreditRefundConfig(), Date.now()),
      }, detailOf(event));
    default:
      break;
  }
  return impossible(ctx, event);
}

// ── succeeded, needs_attention ───────────────────────────────────────

/**
 * The two terminal lines: Stripe's later word changes the copies only.
 * @param ctx - The locked row.
 * @param event - The event.
 * @returns The row after.
 */
async function fromFinished(ctx: Ctx, event: OperationEvent): Promise<CreditRefundOperation> {
  switch (event.type) {
    case "E2":
    case "E3":
    case "E4":
    case "E5":
    case "E6":
    case "E13":
    case "E16":
      return move(ctx, EVENT_NAME[event.type], {}, detailOf(event));
    case "E14": {
      const open = ctx.row.status === "needs_attention" && ctx.row.attentionClosedAt === null;
      return move(ctx, EVENT_NAME.E14, open ? { attentionClosedBy: event.closedBy } : {}, detailOf(event));
    }
    default:
      return impossible(ctx, event);
  }
}

// ── the moves ────────────────────────────────────────────────────────

/**
 * Write a change and its event row.
 * @param ctx - The locked row.
 * @param event - The `event` column.
 * @param patch - The change; empty for a cell that stays.
 * @param detail - The event's detail.
 * @returns The row after.
 */
async function move(
  ctx: Ctx,
  event: string,
  patch: OperationPatch,
  detail: Record<string, unknown>,
): Promise<CreditRefundOperation> {
  const after = await operationRepo.update(ctx.row.id, patch, ctx.tx);
  await operationRepo.appendEvent(
    { operationId: after.id, event, fromStatus: ctx.row.status, toStatus: after.status, detail },
    ctx.tx,
  );
  return after;
}

/**
 * Refuse a cell that cannot happen.
 * @param ctx - The locked row.
 * @param event - The event.
 * @throws {ImpossibleTransitionError} Always.
 */
function impossible(ctx: Ctx, event: OperationEvent): never {
  throw new ImpossibleTransitionError(ctx.row.status, event.type);
}

/**
 * Leave `started` for `awaiting_stripe`: the lease goes, the loop looks next.
 * @param ctx - The locked row.
 * @param event - The event.
 * @param patch - What else to record.
 * @returns The row after.
 */
function toAwaiting(
  ctx: Ctx,
  event: OperationEvent,
  patch: OperationPatch,
): Promise<CreditRefundOperation> {
  return move(ctx, EVENT_NAME[event.type], {
    ...patch,
    status: "awaiting_stripe",
    lease: null,
    nextAttemptInSeconds: nextAttemptDelaySeconds(1, getCreditRefundConfig()),
  }, detailOf(event));
}

/**
 * Finish as `needs_attention`, open until a later disposition closes it.
 * @param ctx - The locked row.
 * @param event - The event.
 * @param reason - Why a person is needed.
 * @param attentionDetail - What the person reads first.
 * @param patch - What else to record.
 * @returns The row after.
 */
function toAttention(
  ctx: Ctx,
  event: OperationEvent,
  reason: AttentionReason,
  attentionDetail: string | null,
  patch: OperationPatch = {},
): Promise<CreditRefundOperation> {
  return move(ctx, EVENT_NAME[event.type], {
    ...patch,
    status: "needs_attention",
    attentionReason: reason,
    attentionDetail,
    finished: true,
    lease: null,
    nextAttemptInSeconds: null,
  }, detailOf(event));
}

/**
 * Finish as `succeeded`, then close the lot's open attentions, answer for
 * failed refunds, and tell the buyer — in the §9 lock order.
 * @param ctx - The locked row.
 * @param event - The `event` column.
 * @param detail - The event's detail.
 * @param finish - The result and what follows it.
 * @returns The row after.
 */
async function toSucceeded(
  ctx: Ctx,
  event: string,
  detail: Record<string, unknown>,
  finish: Finish,
): Promise<CreditRefundOperation> {
  const after = await move(ctx, event, {
    ...finish.patch,
    status: "succeeded",
    result: finish.result,
    finished: true,
    lease: null,
    nextAttemptInSeconds: null,
  }, detail);
  await afterSucceeded(ctx, after, finish);
  return after;
}

/**
 * What every `succeeded` finish does after its own row.
 * @param ctx - The transaction and the locked lot.
 * @param op - The finished disposition.
 * @param finish - What follows it.
 */
async function afterSucceeded(ctx: Ctx, op: CreditRefundOperation, finish: Finish): Promise<void> {
  for (const id of await operationRepo.listOpenAttention(op.lotId, op.id, ctx.tx)) {
    await transitionOperation(ctx.tx, { id }, {
      type: "E14",
      closedBy: op.id,
      actor: ctx.actor,
    });
  }
  await refundCopyRepo.markResolved(op.lotId, finish.resolve ?? [], op.id, ctx.tx);
  if (!finish.tell) return;
  const lot = ctx.lot;
  if (finish.tell.kind === "refund_rejected") {
    await notificationService.createCreditRefundRejected({
      userId: lot.userId,
      payload: { lotId: lot.id, credits: lot.purchasedCredits },
      tx: ctx.tx,
    });
  } else if (finish.tell.kind === "refund_restored") {
    await notificationService.createCreditRefundRestored({
      userId: lot.userId,
      payload: { lotId: lot.id, credits: lot.purchasedCredits },
      tx: ctx.tx,
    });
  } else {
    const paid = await paymentRepo.readPaidAmount(op.paymentId, ctx.tx);
    await notificationService.createCreditRefundCompleted({
      userId: lot.userId,
      payload: {
        lotId: lot.id,
        credits: lot.purchasedCredits,
        amountCents: finish.tell.amountCents,
        currency: paid!.currency,
      },
      tx: ctx.tx,
    });
  }
  await refundMailRepo.insertAuto(op.id, finish.tell.kind, ctx.tx);
}

/**
 * Book an approval or retry on its refund (§5.5): the caller found the
 * settle rule satisfied (E2). A lot that is no longer `refunding` was
 * changed by hand (§6.1); a person decides, and the lot is left alone.
 * @param ctx - The locked row.
 * @param event - The E2 event.
 * @returns The row after.
 */
async function book(
  ctx: Ctx,
  event: Made<RefundEvent>,
): Promise<CreditRefundOperation> {
  if (ctx.lot.lifecycle !== "refunding") return stateMismatch(ctx, event, { stripeRefundId: event.refund.id });
  const copies = await refundCopyRepo.listForPayment(ctx.row.paymentId, ctx.tx);
  const settledCents = succeededCents(copies);
  const answered = await unresolvedIds(ctx.tx, ctx.row.lotId);
  await creditLotService.settleRefund({ lotId: ctx.row.lotId, refundId: event.refund.id }, ctx.tx);
  return toSucceeded(ctx, EVENT_NAME.E2, detailOf(event), {
    result: "refunded",
    patch: { stripeRefundId: event.refund.id, settledSucceededCents: settledCents },
    resolve: answered,
    tell: ctx.row.notify ? { kind: "refund_completed", amountCents: settledCents } : null,
  });
}

/**
 * The lot left `refunding` by a hand outside the product (§6.1): finish as
 * `needs_attention(state_mismatch)` naming what was found.
 * @param ctx - The locked row.
 * @param event - The event that found it.
 * @param patch - What else to record.
 * @returns The row after.
 */
function stateMismatch(
  ctx: Ctx,
  event: OperationEvent,
  patch: OperationPatch,
): Promise<CreditRefundOperation> {
  return toAttention(ctx, event, "state_mismatch", `lot is ${ctx.lot.lifecycle}`, patch);
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * The event's payload, for its event row.
 * @param event - The event.
 * @returns The request body (E1), the refund, the Stripe failure fields (with
 *   the create's failure on an E16 after a create), the reason or the closer;
 *   always the actor.
 */
function detailOf(event: OperationEvent): Record<string, unknown> {
  const actor = { actor: event.actor };
  if (event.type === "E1") {
    const { kind, notify, confirmedRefundIds, confirmedSucceededCents, failedRefundIds } = event.create;
    return { kind, notify, confirmedRefundIds, confirmedSucceededCents, failedRefundIds, ...actor };
  }
  if (event.type === "E14") return { closedBy: event.closedBy, ...actor };
  const refund = "refund" in event ? event.refund : undefined;
  return {
    ...(refund && {
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        failureReason: refund.failure_reason ?? null,
      },
    }),
    ...("failure" in event && event.failure),
    ...("createFailure" in event && event.createFailure && { createFailure: event.createFailure }),
    ...("reason" in event && { reason: event.reason }),
    ...actor,
  };
}

/**
 * Why a person is needed after E6 under `started` (§5.4, §6.2): a refund that
 * had succeeded before it failed came back; Stripe refusing the refund, by
 * the one definition E11 reads too; otherwise a first request Stripe never
 * executed (401, 403, 404), which is ours to fix.
 * @param ctx - The locked row.
 * @param event - The E6 event.
 * @returns The attention reason.
 */
async function declineReason(ctx: Ctx, event: Made<DeclineEvent>): Promise<AttentionReason> {
  if (await everSucceeded(ctx, event)) return "stripe_refund_failed_later";
  return isStripeRefusal(detailOf(event)) ? "stripe_declined" : "stripe_request_invalid";
}

/** The event rows that carry a create answer in `detail`; E16 keeps it in `detail.createFailure`. */
const CREATE_ANSWER_EVENTS = new Set([
  EVENT_NAME.E6,
  EVENT_NAME.E7,
  EVENT_NAME.E8,
  EVENT_NAME.E9,
  EVENT_NAME.E17,
  "late_answer",
]);

/**
 * Why a person is needed when the attempts ran out, and what they read first
 * (§5.1, §5.4, §6.2 E11): Stripe refused if any create answer this
 * disposition received was a refusal, and that answer's own text is shown;
 * otherwise the last error recorded.
 * @param ctx - The locked row.
 * @returns stripe_declined with the refusal's text, or attempts_exhausted.
 */
async function exhaustedAttention(ctx: Ctx): Promise<{ reason: AttentionReason; detail: string | null }> {
  const events = await operationRepo.listEvents(ctx.row.id, ctx.tx);
  for (const e of events) {
    // A late answer carries the event it would have been under `answer`.
    const readFailed = e.event === EVENT_NAME.E16 || (e.event === "late_answer" && e.detail["answer"] === "E16");
    const created = readFailed ? e.detail["createFailure"] : CREATE_ANSWER_EVENTS.has(e.event) ? e.detail : undefined;
    if (typeof created === "object" && created !== null && isStripeRefusal(created as StoredCreateAnswer)) {
      return { reason: "stripe_declined", detail: answerText(created as StoredCreateAnswer) };
    }
  }
  return { reason: "attempts_exhausted", detail: lastErrorLine(ctx) };
}

/**
 * What a person reads first about an E6 or E11 answer (§5.1): a refund that
 * failed or was canceled, a create answer that made no refund (refused, or
 * 401, 403, 404), or the refusal E11 found in the event rows. It is the
 * refund's failure reason, else its status, else the first line of Stripe's
 * error.
 * @param answer - The answer as an event row keeps it.
 * @returns The text, or null when the answer carries none.
 */
function answerText(answer: StoredCreateAnswer): string | null {
  if (answer.refund) return answer.refund.failureReason ?? answer.refund.status ?? null;
  return typeof answer["message"] === "string" ? firstLine(answer["message"]) : null;
}

/**
 * The refund id an E6 carries, as a patch.
 * @param event - The E6 event.
 * @returns `{ stripeRefundId }`, or nothing when it carries no refund.
 */
function refundIdOf(event: DeclineEvent): OperationPatch {
  return event.refund ? { stripeRefundId: event.refund.id } : {};
}

/**
 * What a person reads first when the waiting ran out: the last error recorded.
 * @param ctx - The locked row.
 * @returns Its first line, or null for none.
 */
function lastErrorLine(ctx: Ctx): string | null {
  return ctx.row.lastError === null ? null : firstLine(ctx.row.lastError);
}

/**
 * The first line of a message.
 * @param message - A possibly multi-line message.
 * @returns Its first line.
 */
function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}
