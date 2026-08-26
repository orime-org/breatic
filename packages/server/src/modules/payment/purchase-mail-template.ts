// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one purchase's confirmation says, in the language it was bought in.
 *
 * Written in the buyer's language at the time of purchase rather than the
 * language of whatever request triggers the send: a resend from another device
 * would otherwise switch languages halfway through a record the buyer keeps.
 * The locale is stored on the payment for exactly this reason.
 *
 * Two dates sit next to each other and a buyer subtracts them, so both come
 * from the same instant the lot was opened: the purchase time, and thirty days
 * on from it. Each is printed twice — once in the buyer's own zone, once in
 * UTC — because the zone is the buyer's browser's and UTC is what the server
 * recorded.
 */

import { t } from "@breatic/shared";
import type { ConfirmationView } from "@server/modules/payment/payment.repo.js";

/** The refund window, in whole UTC days from the moment the lot opened. */
const REFUND_WINDOW_DAYS = 30;

/**
 * Money as the buyer's receipt shows it.
 * @param cents - The amount.
 * @param currency - Its ISO code.
 * @param locale - The buyer's locale.
 * @returns The formatted amount.
 */
function money(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * One instant, written both in the buyer's zone and in UTC.
 * @param at - The instant.
 * @param timeZone - The buyer's IANA zone, as reported by their browser.
 * @param locale - The buyer's locale.
 * @returns Both readings on one line.
 */
function bothZones(at: Date, timeZone: string, locale: string): string {
  const local = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(at);
  const utc = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at);
  return `${local} (${timeZone}) · ${utc} (UTC)`;
}

/** The subject and both bodies of one confirmation. */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render one purchase's confirmation email.
 * @param view - What this purchase is, as read from our own rows.
 * @param timeZone - The buyer's IANA zone, stored at checkout.
 * @returns The subject and both bodies.
 */
export function renderPurchaseConfirmation(
  view: ConfirmationView,
  timeZone = "UTC",
): RenderedMail {
  const locale = view.locale;
  const paidAt = view.grantedAt ?? new Date();
  const refundBy = new Date(paidAt);
  refundBy.setUTCDate(refundBy.getUTCDate() + REFUND_WINDOW_DAYS);

  const charged = view.totalCents ?? view.amountCents;
  const lines = [
    t("server.purchase_mail.credits", {
      credits: String(view.creditsGranted),
    }),
    t("server.purchase_mail.balance", {
      credits: String(view.balanceCredits),
    }),
    t("server.purchase_mail.subtotal", {
      amount: money(view.amountCents, view.currency, locale),
    }),
    t("server.purchase_mail.tax", {
      amount: money(view.taxCents ?? 0, view.currency, locale),
    }),
    t("server.purchase_mail.total", {
      amount: money(charged, view.currency, locale),
    }),
    t("server.purchase_mail.purchased_at", {
      when: bothZones(paidAt, timeZone, locale),
    }),
    t("server.purchase_mail.refund_by", {
      when: bothZones(refundBy, timeZone, locale),
    }),
  ];

  const text = [t("server.purchase_mail.intro"), "", ...lines].join("\n");
  const html = [
    `<p>${t("server.purchase_mail.intro")}</p>`,
    "<ul>",
    ...lines.map((line) => `<li>${line}</li>`),
    "</ul>",
  ].join("\n");

  return { subject: t("server.purchase_mail.subject"), html, text };
}
