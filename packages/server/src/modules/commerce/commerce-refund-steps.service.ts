// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One refund step the billing service takes on the product's lot (inner#1993
 * §3.3 `refund-steps`, §8.2): the lot is locked, moved along one of the five
 * refund edges and its bell notice written, once per operation and step. A
 * lot no longer where the edge starts is refused with 409 and left as it is;
 * that refusal is stored and answers every repeat.
 */

import {
  AppError,
  accountOnlyConsent,
  fingerprint,
  logger,
  trackServerEvent,
  type DbTx,
  type RefundStep,
  type RefundStepRequest,
} from "@breatic/core";
import { creditLotRepo, creditLotService } from "@breatic/domain";
import type { CreditLotEntity } from "@breatic/shared";
import { answerOnce } from "@server/modules/commerce/commerce-request.service.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";
import { toLotRefundFacts } from "@server/modules/commerce/commerce-refund-lots.service.js";
import * as notificationService from "@server/modules/notification/notification.service.js";

const ROUTE = "/internal/v1/commerce/refund-steps/:operationId/:step";

/**
 * Take one edge on a locked lot.
 * @param request - The step.
 * @param tx - The transaction holding the lot's lock.
 * @returns The lot after it.
 * @throws {AppError} 409 when the lot is not where the edge starts.
 */
function takeEdge(request: RefundStepRequest, tx: DbTx): Promise<CreditLotEntity> {
  const { lotId, referenceId } = request;
  switch (request.step) {
    case "mark_refunding":
      return creditLotService.markRefunding({ lotId }, tx);
    case "settle":
      return creditLotService.settleRefund({ lotId, refundId: referenceId }, tx);
    case "send_back":
      return creditLotService.sendBackRefund({ lotId }, tx);
    case "reject":
      return creditLotService.rejectRefund({ lotId, operationId: referenceId }, tx);
    case "restore":
      return creditLotService.restoreRefundedCredits({ lotId, operationId: referenceId }, tx);
  }
}

/**
 * Write the bell notice a finished disposition owes the buyer.
 * @param lot - The lot after the edge.
 * @param tell - What to tell.
 * @param tx - The step's transaction.
 */
async function tellBuyer(lot: CreditLotEntity, tell: NonNullable<RefundStepRequest["tell"]>, tx: DbTx): Promise<void> {
  const base = { lotId: lot.id, credits: lot.purchasedCredits };
  if (tell.kind === "refund_rejected") {
    await notificationService.createCreditRefundRejected({ userId: lot.userId, payload: base, tx });
  } else if (tell.kind === "refund_restored") {
    await notificationService.createCreditRefundRestored({ userId: lot.userId, payload: base, tx });
  } else {
    await notificationService.createCreditRefundCompleted({
      userId: lot.userId,
      payload: { ...base, amountCents: tell.amountCents, currency: tell.currency },
      tx,
    });
  }
}

/**
 * Send `refund_completed` under the account's latest reported consent.
 * @param lot - The settled lot.
 * @param amountCents - What went back to the buyer.
 * @param currency - In which currency.
 */
async function reportRefundCompleted(lot: CreditLotEntity, amountCents: number, currency: string): Promise<void> {
  try {
    trackServerEvent(
      "refund_completed",
      { userId: lot.userId, insertId: `refund:${lot.id}`, properties: { credits: Number(lot.purchasedCredits), amount_cents: amountCents, currency } },
      await accountOnlyConsent(lot.userId),
    );
  } catch (err) {
    logger.error({ err, lotId: lot.id }, "refund_completed_failed");
  }
}

/**
 * Take one refund step once per operation and step.
 * @param operationId - The billing service's refund operation.
 * @param step - The step, also named in the request.
 * @param request - The lot, the step, its ledger reference and what to tell the buyer.
 * @returns 200 applied or 409 refused, each with the lot after; 404 `lot_not_found`; 422 for a reused key.
 * @throws {Error} When the database fails; nothing is stored, so a retry takes the step again.
 */
export async function applyRefundStep(operationId: string, step: RefundStep, request: RefundStepRequest): Promise<StoredAnswer> {
  let settled: CreditLotEntity | null = null;
  const answer = await answerOnce(
    { key: `refund:${operationId}:${step}`, kind: "refund", hash: fingerprint("POST", ROUTE, `${operationId}:${step}`, request) },
    async (tx) => {
      if ((await creditLotRepo.lockLiveLot(request.lotId, tx)) === null) {
        return { status: "refused", httpStatus: 404, body: { code: "lot_not_found" } };
      }
      let lot: CreditLotEntity;
      try {
        lot = await takeEdge(request, tx);
      } catch (err) {
        if (!(err instanceof AppError && err.statusCode === 409)) throw err;
        const [facts] = await creditLotRepo.readLotRefundFacts([request.lotId]);
        return { status: "refused", httpStatus: 409, body: { status: "refused", code: "lot_state_changed", lot: toLotRefundFacts(facts!) } };
      }
      if (request.tell !== null) await tellBuyer(lot, request.tell, tx);
      if (step === "settle") settled = lot;
      const [facts] = await creditLotRepo.readLotRefundFacts([request.lotId]);
      return { status: "applied", httpStatus: 200, body: { status: "applied", lot: toLotRefundFacts(facts!) } };
    },
  );
  const { tell } = request;
  if (settled !== null && tell?.kind === "refund_completed") await reportRefundCompleted(settled, tell.amountCents, tell.currency);
  return answer;
}
