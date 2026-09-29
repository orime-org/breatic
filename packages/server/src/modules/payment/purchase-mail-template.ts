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
 * ticked is the whole mechanism. The refund deadline is a moment rather than
 * "within 30 days": a buyer has to be able to tell whether they still have
 * time.
 *
 * Written in the buyer's language at the time of purchase rather than the
 * language of whatever request triggers the send: a resend from another device
 * would otherwise switch languages halfway through a record the buyer keeps.
 * The locale is stored on the payment for exactly this reason, and so are the
 * two wording versions — a rewording must not rewrite what an old purchase
 * agreed to.
 *
 * Two instants sit next to each other and a buyer subtracts them, so both are
 * written the same way: once in the buyer's own zone, once in UTC. The zone is
 * their browser's, stored at checkout; UTC is what the server recorded. The
 * deadline is the last millisecond of the thirtieth UTC day, which read east
 * of UTC falls on the following morning and west of it on the same afternoon
 * — a bare date would leave the buyer guessing which of those they were
 * given.
 */

import { refundWindowCloses, t } from "@breatic/shared";
import { getMailLayout, runWithLocale } from "@breatic/core";
import { renderMail, type RenderedMail } from "@server/utils/mail-shell.js";
import type { ConfirmationView } from "@server/modules/payment/payment.repo.js";
import {
  consentTextAt,
  refundLinesAt,
} from "@server/modules/payment/legal-text.js";

/**
 * Where the stored legal wording marks its emphasis.
 *
 * One string serves three readers: the confirm dialog the buyer ticks on, and
 * both bodies of this letter. The wording carries `**` around the sentence it
 * stresses, and each reader renders that its own way. Plain text renders
 * nothing, so the markers reach it as characters unless they are turned into
 * what they mean.
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
function formatMoney(cents: number, currency: string, locale: string): string {
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

const SECTION_HEADING =
  "margin:24px 0 8px;font-size:15px;font-weight:600;line-height:1.4;";
const LIST = "margin:12px 0 0;padding-left:20px;font-size:14px;line-height:1.7;";
const PARAGRAPH = "margin:0;font-size:14px;line-height:1.6;";
const MONEY_TABLE = "width:100%;margin:16px 0 0;border-collapse:collapse;font-size:14px;line-height:1.6;";
const MONEY_CELL = "padding:4px 0;";
const TOTAL_CELL = "padding:10px 0 4px;border-top:1px solid rgba(30,30,30,0.12);font-weight:600;";
const REFERENCE = "margin:16px 0 0;font-size:13px;line-height:1.7;color:#5f5f5f;";

/** One fact of the receipt: its label and its value, both in the buyer's language. */
interface Fact {
  label: string;
  value: string;
}

/**
 * One row of the money table; the amount sits at the right edge.
 * @param fact - The label and the amount.
 * @param cell - The row's cell style.
 * @returns The table row.
 */
function moneyRow(fact: Fact, cell: string): string {
  return `<tr><td style="${cell}">${fact.label}</td><td align="right" style="${cell}white-space:nowrap;">${fact.value}</td></tr>`;
}

/**
 * One fact as a plain-text line, with the language's own separator.
 * @param fact - The label and the value.
 * @returns The line.
 */
function factLine(fact: Fact): string {
  return t("server.purchase_mail.fact_line", { label: fact.label, value: fact.value });
}

/**
 * Render one purchase's confirmation email, in the branded layout every
 * product mail wears.
 * @param view - What this purchase is, as read from our own rows.
 * @param timeZone - The buyer's IANA zone, stored at checkout.
 * @returns The laid-out mail (to / subject / html / text) for the outbox send.
 */
export function renderPurchaseConfirmation(
  view: ConfirmationView,
  timeZone = "UTC",
): Promise<RenderedMail> {
  const locale = view.locale;
  const paidAt = view.grantedAt ?? new Date();
  const refundBy = refundWindowCloses(paidAt);

  const charged = view.totalCents ?? view.amountCents;
  const consent = consentTextAt(
    view.consentTextVersion ?? "consent-credits-v1",
    locale,
  );
  const refundLines = refundLinesAt(
    view.refundTextVersion ?? "refund-credits-v1",
    locale,
  );

  const details = runWithLocale(locale, () => {
    /**
     * A fact with its catalog label.
     * @param name - The label's key under `server.purchase_mail.label`.
     * @param value - The value, already formatted.
     * @returns The fact.
     */
    const fact = (name: string, value: string): Fact => ({
      label: t(`server.purchase_mail.label.${name}`),
      value,
    });
    const money = [
      fact("credits", t("server.purchase_mail.credits_amount", { credits: String(view.creditsGranted) })),
      fact("subtotal", formatMoney(view.amountCents, view.currency, locale)),
      fact("tax", formatMoney(view.taxCents ?? 0, view.currency, locale)),
    ];
    const total = fact("total", formatMoney(charged, view.currency, locale));
    const reference = [
      fact("balance", t("server.purchase_mail.credits_amount", { credits: String(view.balanceCredits) })),
      fact("purchased_at", bothZones(paidAt, timeZone, locale)),
      fact("refund_by", bothZones(refundBy, timeZone, locale)),
      fact("order_ref", view.paymentId),
    ];
    const consentHeading = t("server.purchase_mail.consent_heading");
    const refundHeading = t("server.purchase_mail.refund_heading");

    const text = [
      ...[...money, total, ...reference].map(factLine),
      "",
      consentHeading,
      asPlainText(consent),
      "",
      refundHeading,
      ...refundLines.map(asPlainText),
    ].join("\n");

    const html = [
      `<table role="presentation" style="${MONEY_TABLE}">`,
      ...money.map((row) => moneyRow(row, MONEY_CELL)),
      moneyRow(total, TOTAL_CELL),
      "</table>",
      `<div style="${REFERENCE}">${reference.map(factLine).join("<br>")}</div>`,
      `<div style="${SECTION_HEADING}">${consentHeading}</div>`,
      `<p style="${PARAGRAPH}">${asHtml(consent)}</p>`,
      `<div style="${SECTION_HEADING}">${refundHeading}</div>`,
      `<ul style="${LIST}">`,
      ...refundLines.map((line) => `<li>${asHtml(line)}</li>`),
      "</ul>",
    ].join("\n");

    return { html, text };
  });

  return renderMail(locale, {
    to: view.email,
    subject: { key: "server.purchase_mail.subject" },
    body: [{ key: "server.purchase_mail.intro" }],
    details,
    note: { key: "server.purchase_mail.support", params: { email: getMailLayout().contactEmail } },
  });
}
