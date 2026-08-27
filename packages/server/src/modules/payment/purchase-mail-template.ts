// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one purchase's confirmation says, in the language it was bought in.
 *
 * This letter is the durable record of a distance sale, so it carries eight
 * things and none of them is optional: what was bought, the price and the tax
 * as separate figures, when it was bought, the consent wording **in full**,
 * the refund rule **in full**, an order reference, somewhere to write back,
 * and — for credits — what landed, what the account now holds, and the date
 * the refund window closes.
 *
 * Two of those are the ones most easily reduced to a summary, and a summary
 * would defeat the point. The consent wording is repeated verbatim rather
 * than as "you agreed to our terms": handing the buyer back the words they
 * ticked is the whole mechanism. The refund deadline is a date rather than
 * "within 30 days": a buyer has to be able to count it on a calendar.
 *
 * Written in the buyer's language at the time of purchase rather than the
 * language of whatever request triggers the send: a resend from another device
 * would otherwise switch languages halfway through a record the buyer keeps.
 * The locale is stored on the payment for exactly this reason, and so are the
 * two wording versions — a rewording must not rewrite what an old purchase
 * agreed to.
 *
 * Two dates sit next to each other and a buyer subtracts them, so both come
 * from the same instant the lot was opened. They are written differently
 * because they answer differently: the purchase time is an instant, printed
 * once in the buyer's own zone and once in UTC, since the zone is their
 * browser's and UTC is what the server recorded; the deadline is a whole UTC
 * calendar day that runs to its own last millisecond, so a clock reading
 * beside it would name a moment hours before the one the rule gives.
 */

import { refundDeadlineDay, t } from "@breatic/shared";
import { runWithLocale } from "@breatic/core";
import type { ConfirmationView } from "@server/modules/payment/payment.repo.js";
import {
  consentTextAt,
  refundLinesAt,
} from "@server/modules/payment/legal-text.js";

/**
 * Where the stored legal wording marks its emphasis.
 *
 * One string serves two readers. Stripe's hosted checkout renders markdown, so
 * the wording carries `**` around the sentence it stresses and the buyer sees
 * it in bold there. This letter renders nothing, so the markers reach it as
 * characters unless they are turned into what they mean.
 */
const EMPHASIS = /\*\*(.+?)\*\*/g;

/**
 * The stored wording as a plain-text reader should see it.
 * @param text - The stored wording.
 * @returns The same words, without the markers.
 */
function asPlainText(text: string): string {
  return text.replace(EMPHASIS, "$1");
}

/**
 * The stored wording as an HTML reader should see it.
 * @param text - The stored wording. It is ours, from the locale files, so it
 *   carries no markup of its own to escape.
 * @returns The same words, with the emphasis as `<strong>`.
 */
function asHtml(text: string): string {
  return text.replace(EMPHASIS, "<strong>$1</strong>");
}

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
 * @param supportEmail - Where a buyer writes back. A deployment that has not
 *   named one gets no such line rather than an empty invitation to write to
 *   nobody.
 * @returns The subject and both bodies.
 */
export function renderPurchaseConfirmation(
  view: ConfirmationView,
  timeZone = "UTC",
  supportEmail = "",
): RenderedMail {
  const locale = view.locale;
  const paidAt = view.grantedAt ?? new Date();
  const refundBy = refundDeadlineDay(paidAt);

  const charged = view.totalCents ?? view.amountCents;
  const consent = consentTextAt(
    view.consentTextVersion ?? "consent-credits-v1",
    locale,
  );
  const refundLines = refundLinesAt(
    view.refundTextVersion ?? "refund-credits-v1",
    locale,
  );

  return runWithLocale(locale, () => {
    const facts = [
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
      t("server.purchase_mail.refund_by", { when: refundBy }),
      t("server.purchase_mail.order_ref", { ref: view.paymentId }),
    ];

    const consentHeading = t("server.purchase_mail.consent_heading");
    const refundHeading = t("server.purchase_mail.refund_heading");
    const support =
      supportEmail === ""
        ? null
        : t("server.purchase_mail.support", { email: supportEmail });

    const text = [
      t("server.purchase_mail.intro"),
      "",
      ...facts,
      "",
      consentHeading,
      asPlainText(consent),
      "",
      refundHeading,
      ...refundLines.map(asPlainText),
      ...(support === null ? [] : ["", support]),
    ].join("\n");

    const html = [
      `<p>${t("server.purchase_mail.intro")}</p>`,
      "<ul>",
      ...facts.map((line) => `<li>${line}</li>`),
      "</ul>",
      `<h3>${consentHeading}</h3>`,
      `<p>${asHtml(consent)}</p>`,
      `<h3>${refundHeading}</h3>`,
      "<ul>",
      ...refundLines.map((line) => `<li>${asHtml(line)}</li>`),
      "</ul>",
      ...(support === null ? [] : [`<p>${support}</p>`]),
    ].join("\n");

    return { subject: t("server.purchase_mail.subject"), html, text };
  });
}
