// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Buying credits, and what became of each purchase.
 *
 * Four calls, in the order a purchase goes through them: read the packs, start
 * a checkout, then either settle the purchase the buyer came back from or
 * abandon the one they pressed Back on. The history is what they read
 * afterwards.
 */

import type { CreditPage, PurchaseRow } from '@breatic/shared';

import { apiGet, apiPost } from '@web/data/api/request';

/** One pack on offer. */
export interface CreditPack {
  /** How many credits it grants. */
  credits: number;
  /** Its listed price, before tax. */
  priceCents: number;
  /** That price's currency. */
  currency: string;
}

/** Everything the buy screen shows before a purchase starts. */
export interface PackList {
  /** The packs, in the order they are shown. */
  packs: CreditPack[];
  /**
   * The refund rule in full, in the reader's language. Versioned on the
   * server, so a purchase made last year can still be shown what it agreed
   * to; the browser holds no copy.
   */
  refundLines: string[];
  /**
   * The sentence the confirm dialog puts its tick against, in the reader's
   * language. The server holds it, so the wording shown and the version
   * recorded against the purchase come from the same place.
   */
  consentText: string;
  /**
   * How long the return page may keep a buyer behind the full-screen wait.
   * Decided on the server, where the value lives; the timer runs here.
   */
  confirmTimeoutMs: number;
}

/** What starting a checkout takes. */
export interface CheckoutRequest {
  /** Which pack, named by its face value. */
  price_cents: number;
  /** Where the buyer came from; both ways back are derived from it. */
  return_url: string;
  /** The buyer's IANA zone, which nothing later in the chain can work out. */
  time_zone: string;
  /**
   * That the buyer ticked the consent on the confirm dialog. The server
   * refuses anything else, and stamps the instant it arrives.
   */
  consented: true;
}

export const paymentApi = {
  /**
   * The packs on offer, and how long the return page may wait for a
   * confirmation before it stops waiting.
   * @returns Both.
   */
  tiers(): Promise<PackList> {
    return apiGet<PackList>('/payment/tiers');
  },

  /**
   * Start paying for one pack.
   * @param body - Which pack, where from, and the buyer's zone.
   * @returns Where to send the buyer.
   */
  checkout(body: CheckoutRequest): Promise<{ url: string }> {
    return apiPost<{ url: string }, CheckoutRequest>('/payment/checkout', body);
  },

  /**
   * Settle the purchase a buyer has just come back from.
   * @param sessionId - The Checkout Session they returned on.
   * @returns What settling it did.
   */
  confirm(sessionId: string): Promise<{ status: string }> {
    return apiPost<{ status: string }, { session_id: string }>(
      '/payment/confirm',
      { session_id: sessionId },
    );
  },

  /**
   * Abandon the purchase a buyer has just pressed Back on.
   * @param paymentId - The purchase, named in the URL they came back on.
   * @returns Where that purchase now stands.
   */
  cancel(paymentId: string): Promise<{ status: string }> {
    return apiPost<{ status: string }, { payment_id: string }>(
      '/payment/cancel',
      { payment_id: paymentId },
    );
  },

  /**
   * One page of this account's purchases, newest first.
   * @param cursor - Where the previous page ended.
   * @returns The page.
   */
  history(cursor?: string): Promise<CreditPage<PurchaseRow>> {
    return apiGet<CreditPage<PurchaseRow>>('/payment/history', {
      params: cursor === undefined ? undefined : { cursor },
    });
  },

  /**
   * Send one purchase's confirmation email again.
   * @param paymentId - The purchase.
   * @returns Whether a letter went out.
   */
  resendConfirmation(paymentId: string): Promise<{ sent: boolean }> {
    return apiPost<{ sent: boolean }>(
      `/payment/${paymentId}/resend-confirmation`,
    );
  },
};
