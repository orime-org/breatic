// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the three buyer emails about a refund say (inner#1410 §8), in the
 * language the pack was bought in and the buyer's own time zone, in the
 * layout every product mail wears. The operator's reason is not part of the
 * view, so it cannot reach a buyer.
 */

import { getAvailableLocales, t } from "@breatic/shared";
import { getMailLayout, runWithLocale } from "@breatic/core";
import { bothZones, formatMoney } from "@server/modules/payment/purchase-mail-template.js";
import { renderMail, type RenderedMail } from "@server/utils/mail-shell.js";

/** What every refund email names. */
interface RefundMailViewBase {
  /** The buyer's address. */
  email: string;
  /** The checkout language, `payments.metadata.locale`. */
  locale: string;
  /** The checkout time zone, `payments.metadata.timeZone`. */
  timeZone: string;
  /** The order reference, `payments.id`. */
  paymentId: string;
  /** The credits the pack granted. */
  credits: number;
  purchasedAt: Date;
}

/** One refund email's facts, by kind. */
export type RefundMailView =
  | (RefundMailViewBase & {
      kind: "refund_completed";
      amountCents: number;
      currency: string;
      refundedAt: Date;
    })
  | (RefundMailViewBase & { kind: "refund_rejected"; requestedAt: Date })
  | (RefundMailViewBase & { kind: "refund_restored"; requestedAt: Date });

const DETAILS = "margin:16px 0 0;font-size:14px;line-height:1.7;";

/**
 * Render one refund email.
 * @param view - What the email is about.
 * @returns The laid-out mail for the outbox send.
 */
export function renderRefundMail(view: RefundMailView): Promise<RenderedMail> {
  // A language we do not write in reads as English, numbers and dates too.
  const locale = getAvailableLocales().includes(view.locale) ? view.locale : "en";
  const section = view.kind.slice("refund_".length);

  const details = runWithLocale(locale, () => {
    /**
     * A fact with its catalog label.
     * @param name - The label's key under `server.refund_mail.label`.
     * @param value - The value, already formatted.
     * @returns The line.
     */
    const line = (name: string, value: string): string =>
      t("server.refund_mail.fact_line", { label: t(`server.refund_mail.label.${name}`), value });
    const credits = t("server.refund_mail.credits_amount", { credits: String(view.credits) });
    const lines =
      view.kind === "refund_completed"
        ? [
            line("amount", formatMoney(view.amountCents, view.currency, locale)),
            line("credits", credits),
            line("purchased_at", bothZones(view.purchasedAt, view.timeZone, locale)),
            line("refunded_at", bothZones(view.refundedAt, view.timeZone, locale)),
            line("order_ref", view.paymentId),
          ]
        : [
            line("credits", credits),
            line("purchased_at", bothZones(view.purchasedAt, view.timeZone, locale)),
            line("requested_at", bothZones(view.requestedAt, view.timeZone, locale)),
            line("order_ref", view.paymentId),
          ];
    return { text: lines.join("\n"), html: `<div style="${DETAILS}">${lines.join("<br>")}</div>` };
  });

  return renderMail(locale, {
    to: view.email,
    subject: { key: `server.refund_mail.${section}.subject` },
    body: [{ key: `server.refund_mail.${section}.intro` }],
    details,
    note: { key: "server.purchase_mail.support", params: { email: getMailLayout().contactEmail } },
  });
}
