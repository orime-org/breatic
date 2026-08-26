// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 确认邮件的正文（任务 #13 §4.5，同意 spec §4.2 的六项加积分侧两项）。
 *
 * 这封信是耐久介质确认，所以它检查的不是「好不好看」，是**八样东西在不在**。
 * 其中两样最容易被写成摘要而不是原文：
 *
 * 一、**买家勾的那段字要原文照抄**，不能写成「您已同意条款」。同意的核心
 * 就是把当时那段字重新给他看。
 *
 * 二、**退款截止要印算好的具体日期**，不能写「30 天内」。买家读到的必须是
 * 一个他能对着日历数的日子。
 *
 * 语言取的是买家买的时候那个，不是触发这次渲染的请求那个——从另一台设备
 * 点重发，信不该换种语言。
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
 * 该语言的同意文案。
 * @param locale - 语言。
 * @returns 当前那一版的文案。
 */
function consentText(locale: string): string {
  return consentTextAt(CONSENT_CREDITS_VERSION, locale);
}

/**
 * 该语言的退款三行。
 * @param locale - 语言。
 * @returns 当前那一版的三行。
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

  it("repeats the consent wording itself, not a summary of it", () => {
    const mail = renderPurchaseConfirmation(view(), "UTC", SUPPORT);
    expect(mail.text).toContain(consentText("en"));
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
      expect(mail.text).toContain(consentText(locale));
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
    expect(mail.html).toContain(consentText("en"));
    for (const line of refundLines("en")) {
      expect(mail.html).toContain(line);
    }
    expect(mail.html).toContain("9f1c7c2e-0000-4000-8000-000000000001");
  });
});
