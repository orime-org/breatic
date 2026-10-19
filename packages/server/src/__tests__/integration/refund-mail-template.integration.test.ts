// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the three refund mails say (inner#1410 §8; `refund_restored` is v9).
 *
 * Contract this suite specifies, in
 * `packages/server/src/modules/credit-refund/refund-mail-template.ts`:
 *
 * ```ts
 * interface RefundMailViewBase {
 *   email: string;      // users.email
 *   locale: string;     // payments.metadata.locale ("en" when absent)
 *   timeZone: string;   // payments.metadata.timeZone ("UTC" when absent)
 *   paymentId: string;  // the order reference
 *   credits: number;    // the pack's credits
 *   purchasedAt: Date;
 * }
 * export type RefundMailView =
 *   | (RefundMailViewBase & { kind: "refund_completed"; amountCents: number; currency: string; refundedAt: Date })
 *   | (RefundMailViewBase & { kind: "refund_rejected"; requestedAt: Date })
 *   | (RefundMailViewBase & { kind: "refund_restored"; requestedAt: Date });
 * export function renderRefundMail(view: RefundMailView): Promise<RenderedMail>;
 * ```
 *
 * Wording lives under `server.refund_mail` in the five locale files. A
 * locale outside en, zh-CN, zh-TW, ja, ko renders exactly as `en`, numbers
 * included. The amount is `Intl.NumberFormat(locale, { style: "currency" })`
 * of the cents. Times are shown in the buyer's zone. The shell is
 * `renderMail`, with the same help line as the purchase confirmation. The
 * view carries no operator reason, so none can reach the letter (the end to
 * end check is in `refund-mail-send.integration.test.ts`).
 *
 * Like the purchase confirmation's suite, this one reaches no database: it
 * sits among the integration tests for the real locale files and config.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { getMailLayout, initCore, loadLocales, MONOREPO_ROOT } from "@breatic/core";
import {
  renderRefundMail,
  type RefundMailView,
} from "@server/modules/credit-refund/refund-mail-template.js";
import { renderPurchaseConfirmation } from "@server/modules/payment/purchase-mail-template.js";
import { CONSENT_CREDITS_VERSION, REFUND_CREDITS_VERSION } from "@server/modules/payment/legal-text.js";

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // already initialised by a sibling suite in this worker — fine.
  }
  loadLocales();
});

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
const PAYMENT_ID = "9f1c7c2e-0000-4000-8000-0000000000aa";

/** 01:30 UTC is 09:30 in Shanghai. */
const PURCHASED_AT = new Date("2026-09-01T01:30:00.000Z");
/** 02:45 UTC is 10:45 in Shanghai. */
const REQUESTED_AT = new Date("2026-09-03T02:45:00.000Z");
/** 03:15 UTC is 11:15 in Shanghai. */
const REFUNDED_AT = new Date("2026-09-05T03:15:00.000Z");

/**
 * A completed refund's view.
 * @param over - Fields to change.
 * @returns The view.
 */
function completed(over: Partial<Extract<RefundMailView, { kind: "refund_completed" }>> = {}): RefundMailView {
  return {
    kind: "refund_completed",
    email: "buyer@example.test",
    locale: "en",
    timeZone: "UTC",
    paymentId: PAYMENT_ID,
    credits: 880,
    purchasedAt: PURCHASED_AT,
    amountCents: 1080,
    currency: "usd",
    refundedAt: REFUNDED_AT,
    ...over,
  };
}

/**
 * A rejected request's view.
 * @param over - Fields to change.
 * @returns The view.
 */
function rejected(over: Partial<Extract<RefundMailView, { kind: "refund_rejected" }>> = {}): RefundMailView {
  return {
    kind: "refund_rejected",
    email: "buyer@example.test",
    locale: "en",
    timeZone: "UTC",
    paymentId: PAYMENT_ID,
    credits: 880,
    purchasedAt: PURCHASED_AT,
    requestedAt: REQUESTED_AT,
    ...over,
  };
}

/**
 * A restored lot's view (v9 §8): credits, purchase time, request time, order reference.
 * @param over - Fields to change.
 * @returns The view.
 */
function restored(over: Partial<Extract<RefundMailView, { kind: "refund_restored" }>> = {}): RefundMailView {
  return {
    kind: "refund_restored",
    email: "buyer@example.test",
    locale: "en",
    timeZone: "UTC",
    paymentId: PAYMENT_ID,
    credits: 880,
    purchasedAt: PURCHASED_AT,
    requestedAt: REQUESTED_AT,
    ...over,
  };
}

/**
 * The amount as the buyer's language writes it.
 * @param cents - Smallest unit.
 * @param currency - ISO code.
 * @param locale - The buyer's language.
 * @returns The formatted amount.
 */
function money(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

/**
 * The purchase confirmation's help line in a language: the plain-text block
 * that names the contact address and is not the footer.
 * @param locale - The language.
 * @returns The line.
 */
async function purchaseHelpLine(locale: string): Promise<string> {
  const { contactEmail } = getMailLayout();
  const mail = await renderPurchaseConfirmation(
    {
      paymentId: PAYMENT_ID,
      email: "buyer@example.test",
      locale,
      amountCents: 1000,
      taxCents: 80,
      totalCents: 1080,
      currency: "usd",
      creditsGranted: 880,
      grantedAt: PURCHASED_AT,
      consentTextVersion: CONSENT_CREDITS_VERSION,
      refundTextVersion: REFUND_CREDITS_VERSION,
      timeZone: "UTC",
      balanceCredits: 880,
    },
    "UTC",
  );
  const block = mail.text
    .split("\n\n")
    .find((b) => b.includes(contactEmail) && !b.startsWith("--"));
  expect(block).toBeDefined();
  return block!;
}

/**
 * What one locale file carries under `server.refund_mail`, read off disk so
 * the check stays red when the i18n layer itself is what broke.
 * @param locale - The file.
 * @returns The subtree, or undefined.
 */
function refundWording(locale: string): unknown {
  const raw = readFileSync(resolve(MONOREPO_ROOT, `locales/${locale}.json`), "utf-8");
  return (JSON.parse(raw) as { server: Record<string, unknown> }).server.refund_mail;
}

/**
 * Every leaf path of a JSON subtree.
 * @param node - The subtree.
 * @param prefix - Path so far.
 * @returns The sorted paths.
 */
function leafPaths(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [prefix];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe.each([
  ["refund_completed", completed],
  ["refund_rejected", rejected],
  ["refund_restored", restored],
] as const)("%s wears the layout every product mail wears", (_kind, make) => {
  it("has the header, the heading, the footer and a plain-text part, addressed to the buyer", async () => {
    const mail = await renderRefundMail(make());
    const year = new Date().getUTCFullYear();
    expect(mail.to).toBe("buyer@example.test");
    expect(mail.html).toContain("Collaborate Better");
    expect(mail.html).toContain(`src="${getMailLayout().logoUrl}"`);
    expect(mail.html).toContain(`© ${year} Orime, Inc.`);
    expect(mail.text).toContain(`© ${year} Orime, Inc.`);
    expect(mail.html).not.toContain("%%");
  });

  it.each(LOCALES)("carries the purchase confirmation's help line in %s", async (locale) => {
    const mail = await renderRefundMail(make({ locale }));
    expect(mail.text).toContain(await purchaseHelpLine(locale));
  });
});

describe("refund_completed: the detail block", () => {
  it.each(LOCALES)("writes the refunded amount the way %s writes money", async (locale) => {
    const mail = await renderRefundMail(completed({ locale }));
    expect(mail.text).toContain(money(1080, "usd", locale));
    expect(mail.html).toContain(money(1080, "usd", locale));
  });

  it("writes the amount in the payment's own currency", async () => {
    const mail = await renderRefundMail(completed({ currency: "eur", amountCents: 950 }));
    expect(mail.text).toContain(money(950, "eur", "en"));
  });

  it("names the credits and the order reference", async () => {
    const mail = await renderRefundMail(completed());
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("880");
      expect(body).toContain(PAYMENT_ID);
    }
  });

  it("gives the purchase time and the refund time in the buyer's own zone", async () => {
    const mail = await renderRefundMail(completed({ timeZone: "Asia/Shanghai" }));
    expect(mail.text).toMatch(/9:30/);
    expect(mail.text).toMatch(/11:15/);
  });
});

describe("refund_rejected: the detail block", () => {
  it("names the credits and the order reference", async () => {
    const mail = await renderRefundMail(rejected());
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("880");
      expect(body).toContain(PAYMENT_ID);
    }
  });

  it("gives the purchase time and the request time in the buyer's own zone", async () => {
    const mail = await renderRefundMail(rejected({ timeZone: "Asia/Shanghai" }));
    expect(mail.text).toMatch(/9:30/);
    expect(mail.text).toMatch(/10:45/);
  });
});

describe("refund_restored: the detail block (v9 §8)", () => {
  it("names the credits and the order reference", async () => {
    const mail = await renderRefundMail(restored());
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("880");
      expect(body).toContain(PAYMENT_ID);
    }
  });

  it("gives the purchase time and the request time in the buyer's own zone", async () => {
    const mail = await renderRefundMail(restored({ timeZone: "Asia/Shanghai" }));
    expect(mail.text).toMatch(/9:30/);
    expect(mail.text).toMatch(/10:45/);
  });

  it.each(LOCALES)("in %s, its subject and intro come from server.refund_mail.restored", async (locale) => {
    const wording = refundWording(locale) as { restored?: { subject?: string; intro?: string } } | undefined;
    expect(wording?.restored?.subject, `${locale} server.refund_mail.restored.subject`).toEqual(expect.any(String));
    expect(wording?.restored?.intro, `${locale} server.refund_mail.restored.intro`).toEqual(expect.any(String));
    const mail = await renderRefundMail(restored({ locale }));
    // Every product mail's subject is "Breatic - <heading>" (utils/mail-shell.ts).
    expect(mail.subject).toBe(`Breatic - ${wording!.restored!.subject}`);
  });
});

describe("the three mails in five languages", () => {
  it("the three kinds are three different letters", async () => {
    const a = await renderRefundMail(completed());
    const b = await renderRefundMail(rejected());
    const c = await renderRefundMail(restored());
    expect(new Set([a.subject, b.subject, c.subject]).size).toBe(3);
    expect(c.text).not.toBe(b.text);
  });

  it.each(LOCALES.filter((l) => l !== "en"))("writes every kind in %s, not English", async (locale) => {
    for (const make of [completed, rejected, restored] as ((over?: { locale?: string }) => RefundMailView)[]) {
      const english = await renderRefundMail(make());
      const mail = await renderRefundMail(make({ locale }));
      expect(mail.subject).not.toBe(english.subject);
      expect(mail.text).not.toBe(english.text);
    }
  });

  it.each(LOCALES)("leaves no untranslated key in %s", async (locale) => {
    for (const make of [completed, rejected, restored] as ((over?: { locale?: string }) => RefundMailView)[]) {
      const mail = await renderRefundMail(make({ locale }));
      for (const body of [mail.subject, mail.text, mail.html]) {
        expect(body).not.toContain("server.refund_mail");
        expect(body).not.toContain("server.purchase_mail");
      }
    }
  });

  it.each(["fr", "de", "pt-BR"])("writes a %s buyer's letter exactly as the English one", async (locale) => {
    for (const make of [completed, rejected, restored] as ((over?: { locale?: string }) => RefundMailView)[]) {
      const english = await renderRefundMail(make());
      const mail = await renderRefundMail(make({ locale }));
      expect(mail.subject).toBe(english.subject);
      expect(mail.text).toBe(english.text);
    }
  });

  it("every locale file carries the same server.refund_mail keys as English", () => {
    const english = leafPaths(refundWording("en"));
    expect(english.length).toBeGreaterThan(1);
    for (const locale of LOCALES) {
      const wording = refundWording(locale);
      expect(wording, `${locale} has no server.refund_mail`).toBeDefined();
      expect(leafPaths(wording), locale).toEqual(english);
    }
  });
});
