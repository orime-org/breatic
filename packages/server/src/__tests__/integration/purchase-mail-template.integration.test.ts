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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, beforeAll } from "vitest";
import { getMailLayout, initCore, loadLocales, MONOREPO_ROOT } from "@breatic/core";
import { renderPurchaseConfirmation } from "@server/modules/payment/purchase-mail-template.js";
import {
  consentTextAt,
  refundLinesAt,
  CONSENT_CREDITS_VERSION,
  REFUND_CREDITS_VERSION,
} from "@server/modules/payment/legal-text.js";

import type { ConfirmationView } from "@server/modules/payment/payment.repo.js";

/** Every language the product ships, as the locale files are named. */
const LOCALE_FILES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;

/**
 * What one locale file carries under `server.payment`, read off disk.
 *
 * Read directly rather than through `t()`, so the assertion stays red when
 * the i18n layer itself is what broke.
 * @param locale - The language to read.
 * @returns That file's payment wording, versions and all.
 */
function paymentWording(locale: string): Record<string, unknown> {
  const raw = readFileSync(
    resolve(MONOREPO_ROOT, `locales/${locale}.json`),
    "utf-8",
  );
  return (
    JSON.parse(raw) as { server: { payment: Record<string, unknown> } }
  ).server.payment;
}

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
    consentTextVersion: CONSENT_CREDITS_VERSION,
    refundTextVersion: REFUND_CREDITS_VERSION,
    timeZone: "UTC",
    balanceCredits: 4200,
    ...over,
  };
}

describe("the confirmation wears the layout every product mail wears", () => {
  it("has the header, the heading, the footer and a plain-text part", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    const year = new Date().getUTCFullYear();
    expect(mail.to).toBe(view().email);
    expect(mail.html).toContain("An AI operating system for content creators");
    expect(mail.html).toContain(`src="${getMailLayout().logoUrl}"`);
    expect(mail.html).toContain(`>${mail.subject.replace(/^Breatic - /, "")}</`);
    expect(mail.html).toContain("This is an automated message; replies are not read.");
    expect(mail.html).toContain(`© ${year} Orime, Inc.`);
    expect(mail.text).toContain(`© ${year} Orime, Inc.`);
    expect(mail.html).not.toContain("%%");
  });
});

describe("the confirmation carries all eight things", () => {
  it("shows the price and the tax as two figures, and the total as a third", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    expect(mail.text).toContain("$20.00");
    expect(mail.text).toContain("$2.40");
    expect(mail.text).toContain("$22.40");
  });

  it("gives the purchase time in the buyer's own zone and in UTC", async () => {
    const mail = await renderPurchaseConfirmation(view(), "Asia/Shanghai");
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
  it("gives the refund deadline in the buyer's own zone and in UTC", async () => {
    const mail = await renderPurchaseConfirmation(view(), "Asia/Shanghai");
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
  it("gives every purchase on one UTC day the same deadline", async () => {
    const early = await renderPurchaseConfirmation(
      view({ grantedAt: new Date("2026-08-26T00:05:00.000Z") }),
      "UTC",
    );
    const late = await renderPurchaseConfirmation(
      view({ grantedAt: new Date("2026-08-26T23:55:00.000Z") }),
      "UTC",
    );
    const deadline = (mail: { text: string }): string | undefined =>
      mail.text.split("\n").find((row) => row.includes("Refundable until"));

    expect(deadline(early)).toBe(deadline(late));
  });

  it("repeats the consent wording itself, not a summary of it", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    expect(mail.text).toContain(plainConsent("en"));
  });

  it("repeats every refund line", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    for (const line of refundLines("en")) {
      expect(mail.text).toContain(line);
    }
  });

  it("names the order so a refund request has something to quote", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    expect(mail.text).toContain("9f1c7c2e-0000-4000-8000-000000000001");
  });

  it("says where to write back: the contact address, as a link like the footer's", async () => {
    const { contactEmail } = getMailLayout();
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    expect(mail.text).toContain(`Questions about this purchase? Write to ${contactEmail}.`);
    expect(mail.html).toMatch(
      new RegExp(`Write to <a href="mailto:${contactEmail}" style="[^"]*text-decoration:underline;[^"]*">${contactEmail}</a>\\.`),
    );
  });

  it("gives what landed and what the account now holds", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    expect(mail.text).toContain("1700");
    expect(mail.text).toContain("4200");
  });

  it("prints the refund deadline as the moment it falls, never as a duration", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
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

describe("the receipt sets the money apart from the reference lines", () => {
  it("puts credits, price, tax and total in one label and amount table, the total set off", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    const table = /<table role="presentation"[^>]*>([\s\S]*?)<\/table>/.exec(mail.html.slice(mail.html.indexOf("Thank you")))![1]!;
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1]!.matchAll(/<td([^>]*)>([^<]*)<\/td>/g)].map((c) => ({ attrs: c[1]!, text: c[2]! })),
    );
    expect(rows.map((r) => r.map((c) => c.text))).toEqual([
      ["Credits added", "1700"],
      ["Price", "$20.00"],
      ["Tax", "$2.40"],
      ["Total charged", "$22.40"],
    ]);
    for (const row of rows) expect(row[1]!.attrs).toContain('align="right"');
    for (const cell of rows[3]!) {
      expect(cell.attrs).toContain("font-weight:600");
      expect(cell.attrs).toContain("border-top:1px solid");
    }
  });

  it("lists balance, purchase time, refund deadline and order reference in the muted style below it", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    const after = mail.html.slice(mail.html.indexOf("Total charged"));
    const muted = /<div style="[^"]*font-size:13px;[^"]*color:#5f5f5f;[^"]*">([\s\S]*?)<\/div>/.exec(after)![1]!;
    expect(muted.split("<br>").map((line) => line.split(":")[0])).toEqual([
      "Balance now", "Purchased", "Refundable until", "Order reference",
    ]);
    expect(mail.html).not.toContain("<li>Credits added");
  });

  it("keeps the plain-text part in the same order, one fact per line", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    const lines = mail.text.split("\n").filter((line) => /^[A-Z][a-z ]+: /.test(line)).map((line) => line.split(":")[0]);
    expect(lines.slice(0, 8)).toEqual([
      "Credits added", "Price", "Tax", "Total charged",
      "Balance now", "Purchased", "Refundable until", "Order reference",
    ]);
  });

  it("writes each language's own label and separator", async () => {
    const mail = await renderPurchaseConfirmation(view({ locale: "ja" }), "UTC");
    expect(mail.html).toMatch(/<td[^>]*>お支払い合計<\/td>/);
    expect(mail.text).toContain("お支払い合計：");
    expect(mail.text).toContain("今回の追加：1700 クレジット");
  });
});

describe("the confirmation is written in the language the purchase was made in", () => {
  it.each(["zh-CN", "zh-TW", "ja", "ko"])(
    "writes a %s purchase in %s, whatever the request that triggered it",
    async (locale) => {
      const mail = await renderPurchaseConfirmation(view({ locale }), "UTC");
      expect(mail.text).toContain(plainConsent(locale));
      for (const line of refundLines(locale)) {
        expect(mail.text).toContain(line);
      }
      expect(mail.subject).not.toBe(
        (await renderPurchaseConfirmation(view({ locale: "en" }), "UTC")).subject,
      );
    },
  );
});

describe("the HTML body says the same things as the text one", () => {
  it("carries the consent wording and every refund line", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
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
  it("leaves no asterisks in either body", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    expect(mail.text).not.toContain("**");
    expect(mail.html).not.toContain("**");
  });

  it("keeps the emphasised words themselves", async () => {
    const mail = await renderPurchaseConfirmation(view(), "UTC");
    // The English wording emphasises the sentence about spending a credit.
    expect(mail.text).toContain(
      "once I use any of them I can no longer get this purchase refunded",
    );
    expect(mail.html).toContain(
      "<strong>once I use any of them I can no longer get this purchase refunded</strong>",
    );
  });

  it("does the same in every language we sell in", async () => {
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
      const mail = await renderPurchaseConfirmation(view({ locale }), "UTC");
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

  it.each(LOCALES)("the consent wording resolves in %s", async (locale) => {
    const text = consentText(locale);
    expect(text).not.toContain("server.payment.");
    expect(text.length).toBeGreaterThan(20);
  });

  it.each(LOCALES)("every refund line resolves in %s", async (locale) => {
    // How many lines the version in force has is pinned once, by the test
    // that names it. A line missing from one locale comes back as its own
    // key, which the loop catches whatever the count is.
    const lines = refundLines(locale);
    expect(lines.length).toBeGreaterThan(0);
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
  it("renders the version the purchase stored, not the current one", async () => {
    const mail = await renderPurchaseConfirmation(
      view({
        consentTextVersion: "consent-credits-v99",
        refundTextVersion: "refund-credits-v99",
      }),
      "UTC",
    );

    expect(mail.text).toContain("server.payment.refund-credits-v99.unused");
    expect(mail.text).toContain("server.payment.consent-credits-v99");
    expect(mail.text).not.toContain(plainConsent("en"));
  });

  it("reads back the three lines a v1 purchase agreed to", async () => {
    // The version a purchase records names the wording it was made under, and
    // that wording never changes afterwards. A fourth condition is a new
    // version beside it, so a confirmation resent for a v1 purchase states
    // what that buyer agreed to and not what is asked of buyers today.
    const v1 = refundLinesAt("refund-credits-v1", "en");
    expect(v1).toHaveLength(3);
    expect(v1.join(" ")).not.toContain("assigned to a Studio");

    const today = refundLinesAt(REFUND_CREDITS_VERSION, "en");
    expect(REFUND_CREDITS_VERSION).toBe("refund-credits-v3");
    expect(today).toHaveLength(5);
    expect(today[3]).toContain("not assigned to a Studio");
    expect(today[4]).toContain("was bought");
  });

  it("says so when a version names wording that is not there", async () => {
    // What the guard above is guarding against, shown directly: nothing
    // throws, and the key comes back as though it were the wording.
    expect(refundLinesAt("refund-credits-v99", "en")[0]).toBe(
      "server.payment.refund-credits-v99.unused",
    );
  });

  it("carries every published version of both texts in all five languages", async () => {
    // A purchase records the version it was made under, so reading back a
    // two-year-old one has to keep working: a reworded text becomes `…-v2`
    // beside its predecessor and `…-v1` stays in every locale file forever.
    // Nothing enforced that until this walked the files — the versions come
    // from the wording itself rather than from a list someone maintains, so a
    // `…-v3` added to English and missed in Korean is red here without anyone
    // remembering to add it.
    const english = paymentWording("en");
    const consentVersions = Object.keys(english).filter((key) =>
      key.startsWith("consent-credits-"),
    );
    const refundVersions = Object.keys(english).filter((key) =>
      key.startsWith("refund-credits-"),
    );
    expect(consentVersions.length).toBeGreaterThan(1);
    expect(refundVersions.length).toBeGreaterThan(1);

    for (const locale of LOCALE_FILES) {
      const wording = paymentWording(locale);

      for (const version of consentVersions) {
        expect(typeof wording[version], `${locale} lacks ${version}`).toBe(
          "string",
        );
        expect(consentTextAt(version, locale)).not.toBe(
          `server.payment.${version}`,
        );
      }

      for (const version of refundVersions) {
        const keys = Object.keys(english[version] as object);
        expect(
          Object.keys(wording[version] as object).sort(),
          `${locale} ${version}`,
        ).toEqual([...keys].sort());

        // A version absent from `REFUND_LINE_KEYS` falls back to today's key
        // list, which reads the wrong number of lines out of an older one.
        // Comparing the count is what catches wording added to the locale
        // files and not to that table.
        const lines = refundLinesAt(version, locale);
        expect(lines, `${locale} ${version}`).toHaveLength(keys.length);
        for (const line of lines) {
          expect(line.startsWith(`server.payment.${version}`)).toBe(false);
        }
      }
    }
  });
});
