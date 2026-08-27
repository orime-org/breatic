// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body of the confirmation mail (task #13 §4.5: the six items of the
 * consent spec §4.2 plus the two on the credits side).
 *
 * This letter is the durable-medium confirmation, so what is checked here is
 * not whether it reads nicely but whether all eight things are present. Two of
 * them are the ones most likely to be turned into a summary instead of being
 * quoted:
 *
 * 1. The wording the buyer ticked must be repeated verbatim, never reduced to
 *    "you agreed to the terms". Handing that exact wording back is what the
 *    consent is.
 *
 * 2. The refund deadline must be printed as the computed instant, in the
 *    buyer's own zone beside UTC, never as "within 30 days". What the buyer
 *    reads has to say whether they still have time, wherever they are.
 *
 * The language is the one the purchase was made in, not the one of the request
 * that triggered this render — hitting resend from another device must not
 * switch the letter to a different language.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore, loadLocales } from "@breatic/core";
import { renderPurchaseConfirmation } from "@server/modules/payment/purchase-mail-template.js";
import {
  consentTextAt,
  refundLinesAt,
  CONSENT_CREDITS_VERSION,
  REFUND_CREDITS_VERSION,
} from "@server/modules/payment/legal-text.js";

import type { ConfirmationView } from "@server/modules/payment/payment.repo.js";

/**
 * The consent wording in a given language.
 * @param locale - The language.
 * @returns The wording as the current version has it.
 */
function consentText(locale: string): string {
  return consentTextAt(CONSENT_CREDITS_VERSION, locale);
}

/**
 * The consent wording in a given language, with the emphasis markers removed.
 *
 * The `**` in the wording is there for the Stripe checkout page, which renders
 * markdown; the letter should never show the markers themselves, so assertions
 * against the plain-text body compare with the markers stripped.
 * @param locale - The language.
 * @returns The same sentence, without the markers.
 */
function plainConsent(locale: string): string {
  return consentText(locale).replace(/\*\*(.+?)\*\*/g, "$1");
}

/**
 * The consent wording in a given language, with the emphasis rendered as HTML.
 * @param locale - The language.
 * @returns The same sentence, with the emphasis as `<strong>`.
 */
function htmlConsent(locale: string): string {
  return consentText(locale).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * The three refund lines in a given language.
 * @param locale - The language.
 * @returns The three lines as the current version has them.
 */
function refundLines(locale: string): readonly string[] {
  return refundLinesAt(REFUND_CREDITS_VERSION, locale);
}

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // already initialised by a sibling suite in this worker — fine.
  }
  loadLocales();
});

// This suite reaches no database. It lives among the integration tests
// because it needs the real locale files and the real config: the unit-test
// setup in this package replaces `@breatic/core` wholesale, and a template
// asserted against a stubbed `t()` would assert nothing.

/** Where a buyer writes back, as a deployment would configure it. */
const SUPPORT = "help@example.test";

/** One purchase, as the repo reports it. */
function view(over: Partial<ConfirmationView> = {}): ConfirmationView {
  return {
    paymentId: "9f1c7c2e-0000-4000-8000-000000000001",
    email: "buyer@example.test",
    locale: "en",
    amountCents: 2000,
    taxCents: 240,
    totalCents: 2240,
    currency: "usd",
    creditsGranted: 1700,
    grantedAt: new Date("2026-08-26T01:30:00.000Z"),
    consentTextVersion: "consent-credits-v1",
    refundTextVersion: "refund-credits-v1",
    timeZone: "UTC",
    balanceCredits: 4200,
    ...over,
  };
}

describe("the confirmation carries all eight things", () => {
  it("shows the price and the tax as two figures, and the total as a third", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).toContain("$20.00");
    expect(mail.text).toContain("$2.40");
    expect(mail.text).toContain("$22.40");
  });

  it("gives the purchase time in the buyer's own zone and in UTC", () => {
    const mail = renderPurchaseConfirmation(view(), "Asia/Shanghai", SUPPORT);
    expect(mail.text).toContain("Asia/Shanghai");
    expect(mail.text).toContain("UTC");
    // 01:30 UTC is 09:30 the same day in Shanghai. Both readings are printed,
    // so a buyer reading the local one and a support agent reading the UTC one
    // are looking at the same instant.
    expect(mail.text).toMatch(/9:30/);
    expect(mail.text).toMatch(/1:30/);
  });

  // The same two readings the purchase time gets. The window shuts at the end
  // of the thirtieth UTC day, which east of UTC falls on the next morning and
  // west of it on the same afternoon — a bare date leaves the buyer without
  // the one thing they need to count from.
  it("gives the refund deadline in the buyer's own zone and in UTC", () => {
    const mail = renderPurchaseConfirmation(view(), "Asia/Shanghai", SUPPORT);
    const line = mail.text
      .split("\n")
      .find((row) => row.includes("Refundable until"));

    expect(line).toBeDefined();
    // Bought 2026-08-26 01:30 UTC, so the window shuts at 09-25 23:59:59.999
    // UTC — which in Shanghai is 07:59 on the 26th.
    expect(line).toContain("Asia/Shanghai");
    expect(line).toContain("UTC");
    expect(line).toMatch(/Sep 26, 2026, 7:59/);
    expect(line).toMatch(/Sep 25, 2026, 11:59/);
  });

  // The buyer's own time of day plays no part: two purchases on the same UTC
  // day are refundable up to the same instant.
  it("gives every purchase on one UTC day the same deadline", () => {
    const early = renderPurchaseConfirmation(
      view({ grantedAt: new Date("2026-08-26T00:05:00.000Z") }),
      "UTC",
      SUPPORT,
    );
    const late = renderPurchaseConfirmation(
      view({ grantedAt: new Date("2026-08-26T23:55:00.000Z") }),
      "UTC",
      SUPPORT,
    );
    const deadline = (mail: { text: string }): string | undefined =>
      mail.text.split("\n").find((row) => row.includes("Refundable until"));

    expect(deadline(early)).toBe(deadline(late));
  });

  it("repeats the consent wording itself, not a summary of it", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).toContain(plainConsent("en"));
  });

  it("repeats all three refund lines", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    for (const line of refundLines("en")) {
      expect(mail.text).toContain(line);
    }
  });

  it("names the order so a refund request has something to quote", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).toContain("9f1c7c2e-0000-4000-8000-000000000001");
  });

  it("says where to write back", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).toContain(SUPPORT);
  });

  it("leaves the line out when no deployment has named an address", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", "");
    // An invitation to write to nobody is worse than no invitation.
    expect(mail.text).not.toContain("@");
    expect(mail.html).not.toContain("@");
  });

  it("gives what landed and what the account now holds", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).toContain("1700");
    expect(mail.text).toContain("4200");
  });

  it("prints the refund deadline as a date, never as a duration", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    // Thirty UTC calendar days on from 2026-08-26 is 2026-09-25.
    const deadline = mail.text
      .split("\n")
      .find((line) => line.startsWith("Refundable until:"));
    expect(deadline).toContain("Sep 25, 2026");
    // Only this line is checked, because "30 days" appears legitimately
    // elsewhere in the letter: both the consent wording and the refund rule
    // are quoted verbatim and both say it.
    expect(deadline).not.toMatch(/30 days/);
  });
});

describe("the confirmation is written in the language the purchase was made in", () => {
  it.each(["zh-CN", "zh-TW", "ja", "ko"])(
    "writes a %s purchase in %s, whatever the request that triggered it",
    (locale) => {
      const mail = renderPurchaseConfirmation(view({ locale }), "UTC", SUPPORT);
      expect(mail.text).toContain(plainConsent(locale));
      for (const line of refundLines(locale)) {
        expect(mail.text).toContain(line);
      }
      expect(mail.subject).not.toBe(
        renderPurchaseConfirmation(view({ locale: "en" }), "UTC", SUPPORT).subject,
      );
    },
  );
});

describe("the HTML body says the same things as the text one", () => {
  it("carries the consent wording and every refund line", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.html).toContain(htmlConsent("en"));
    for (const line of refundLines("en")) {
      expect(mail.html).toContain(line);
    }
    expect(mail.html).toContain("9f1c7c2e-0000-4000-8000-000000000001");
  });
});

/**
 * One piece of consent wording has two consumers: the Stripe checkout page,
 * which renders markdown (it really does turn `**` into bold), and this letter,
 * which does not. Each has to end up with the form it needs — not a single
 * asterisk printed as-is in the mail, and the emphasised words still there.
 */
describe("the emphasis in the consent wording is rendered, not printed", () => {
  it("leaves no asterisks in either body", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).not.toContain("**");
    expect(mail.html).not.toContain("**");
  });

  it("keeps the emphasised words themselves", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    // The English wording emphasises the sentence about spending a credit.
    expect(mail.text).toContain(
      "once I use any of them I can no longer get this purchase refunded",
    );
    expect(mail.html).toContain(
      "<strong>once I use any of them I can no longer get this purchase refunded</strong>",
    );
  });

  it("does the same in every language we sell in", () => {
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
      const mail = renderPurchaseConfirmation(view({ locale }), "UTC", SUPPORT);
      expect(mail.text).not.toContain("**");
      expect(mail.html).not.toContain("**");
    }
  });
});

/**
 * Both versions name a key, and `t()` hands an unknown key straight back. So
 * every assertion above that compares the letter against `refundLines(...)`
 * holds just as well when neither side resolves to anything: point the version
 * at wording that does not exist and the letter carries the key, the
 * expectation is the same key, and it all passes.
 *
 * These are the assertions that do not: they say the version currently shipped
 * resolves to real wording, in every language, and would have caught a version
 * bumped without its copy.
 */
describe("both versions name wording that exists", () => {
  const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"];

  it.each(LOCALES)("the consent wording resolves in %s", (locale) => {
    const text = consentText(locale);
    expect(text).not.toContain("server.payment.");
    expect(text.length).toBeGreaterThan(20);
  });

  it.each(LOCALES)("all three refund lines resolve in %s", (locale) => {
    const lines = refundLines(locale);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain("server.payment.");
      expect(line.length).toBeGreaterThan(10);
    }
  });

  // The version travels with the purchase, and the renderer has to read that
  // one rather than whatever is current: a rewording must not rewrite what an
  // old purchase agreed to, and a resend years later still owes the buyer the
  // words they ticked. Asserting it needs no second set of copy — a version
  // nothing was written for comes back as its own key, which is proof enough
  // that the stored version is what the renderer looked up.
  it("renders the version the purchase stored, not the current one", () => {
    const mail = renderPurchaseConfirmation(
      view({
        consentTextVersion: "consent-credits-v99",
        refundTextVersion: "refund-credits-v99",
      }),
      "UTC",
      SUPPORT,
    );

    expect(mail.text).toContain("server.payment.refund-credits-v99.unused");
    expect(mail.text).toContain("server.payment.consent-credits-v99");
    expect(mail.text).not.toContain(plainConsent("en"));
  });

  it("says so when a version names wording that is not there", () => {
    // What the guard above is guarding against, shown directly: nothing
    // throws, and the key comes back as though it were the wording.
    expect(refundLinesAt("refund-credits-v99", "en")[0]).toBe(
      "server.payment.refund-credits-v99.unused",
    );
  });
});
