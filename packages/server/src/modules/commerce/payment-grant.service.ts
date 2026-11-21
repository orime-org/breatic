// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Granting a completed payment the billing service took (inner#1993 §3.3
 * `payment-grants`): the receipt and the lot are written in one transaction,
 * once per payment; the purchase is reported to analytics and ads after the
 * commit.
 */

import { enqueueAdsConversion, fingerprint, logger, trackServerEvent, type PaymentGrantRequest } from "@breatic/core";
import { creditLotRepo, creditLotService, creditSourceRepo } from "@breatic/domain";
import { readAccountFacts } from "@server/modules/auth/user.repo.js";
import { wakeCommerceRelay } from "@server/modules/commerce/commerce-relay.js";
import { answerOnce } from "@server/modules/commerce/commerce-request.service.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";
import * as paymentReceiptRepo from "@server/modules/commerce/payment-receipt.repo.js";

const ROUTE = "/internal/v1/commerce/payment-grants/:paymentId";

/**
 * Whether a stored receipt records the same payment as a request.
 * @param receipt - The stored receipt.
 * @param request - The grant request.
 * @returns True when every figure matches.
 */
function sameReceipt(receipt: paymentReceiptRepo.PaymentReceipt, request: PaymentGrantRequest): boolean {
  return (
    receipt.userId === request.userId &&
    receipt.amountCents === request.amountCents &&
    receipt.taxCents === request.taxCents &&
    receipt.totalCents === request.totalCents &&
    receipt.currency === request.currency &&
    Number(receipt.creditsGranted) === request.purchasedCredits
  );
}

/**
 * Report a granted purchase, the way the in-product checkout did.
 * @param paymentId - The payment.
 * @param request - The grant request, carrying the order's conversion context.
 */
function reportPurchase(paymentId: string, request: PaymentGrantRequest): void {
  const { consent, click, transactionId } = request.conversion;
  trackServerEvent(
    "credit_purchase_completed",
    {
      userId: request.userId,
      insertId: transactionId,
      properties: { credits: request.purchasedCredits, amount_cents: request.amountCents, currency: request.currency },
    },
    consent,
  );
  enqueueAdsConversion(
    {
      userId: request.userId,
      conversion: "credit_purchase",
      transactionId,
      click,
      value: { amountCents: request.amountCents, currency: request.currency },
    },
    { consent: consent.ads },
  ).catch((err: unknown) => {
    logger.error({ err, paymentId }, "ads_conversion_enqueue_failed");
  });
}

/**
 * Grant a payment once, answering the lot it opened.
 * @param paymentId - The payment, which is also its credit source's id.
 * @param request - What was paid and for how many credits.
 * @returns 200 with the lot and when it was granted, a deleted account's included; 404 `account_not_found` for an account that never existed; 409 `receipt_conflict`; 422 for a reused key.
 * @throws {Error} When the database fails.
 */
export async function grantPayment(paymentId: string, request: PaymentGrantRequest): Promise<StoredAnswer> {
  let granted = false;
  // `conversion` is left out of the hash: an account's erasure drops it from
  // the order, so a retry may carry less of it, while who is granted what is
  // decided by the rest (inner#1993 §3.3).
  const { conversion: _conversion, ...intent } = request;
  const answer = await answerOnce(
    { key: `grant:${paymentId}`, kind: "grant", hash: fingerprint("POST", ROUTE, paymentId, intent) },
    async (tx) => {
      if ((await readAccountFacts(request.userId, tx)) === null) {
        return { status: "refused", httpStatus: 404, body: { code: "account_not_found" } };
      }
      await creditSourceRepo.claimSource({ id: paymentId, kind: "payment" }, tx);
      const existing = await creditLotRepo.findLotGrantedFromPayment(paymentId, tx);
      if (existing !== null) {
        return { status: "applied", httpStatus: 200, body: { lotId: existing.id, grantedAt: existing.createdAt.toISOString() } };
      }
      const receipt = await paymentReceiptRepo.findReceipt(paymentId, tx);
      if (receipt !== null && !sameReceipt(receipt, request)) {
        return { status: "refused", httpStatus: 409, body: { code: "receipt_conflict" } };
      }
      if (receipt === null) {
        await paymentReceiptRepo.insertReceipt(
          {
            id: paymentId,
            userId: request.userId,
            amountCents: request.amountCents,
            taxCents: request.taxCents,
            totalCents: request.totalCents,
            currency: request.currency,
            creditsGranted: String(request.purchasedCredits),
            orderedAt: new Date(request.orderedAt),
          },
          tx,
        );
      }
      const lot = await creditLotService.grantFromPayment({ paymentId, userId: request.userId, purchasedCredits: request.purchasedCredits }, tx);
      granted = true;
      return { status: "applied", httpStatus: 200, body: { lotId: lot.id, grantedAt: lot.createdAt.toISOString() } };
    },
  );
  if (granted) {
    wakeCommerceRelay();
    reportPurchase(paymentId, request);
  }
  return answer;
}
