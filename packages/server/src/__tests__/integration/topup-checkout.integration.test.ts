// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 建结账 session 那一步（任务 #13 §4.2、§4.7）—— 真 PG，Stripe 客户端替身。
 *
 * 这一步产出两样东西，两样都必须在同一次调用里对：发给 Stripe 的那个
 * session，和我们自己那行 `payments`。
 *
 * 三处最容易写错的地方，各有一组用例钉着：
 *
 * 一、**`{CHECKOUT_SESSION_ID}` 必须原样发出去**。`new URL()` 配
 * `searchParams.set()` 会把花括号编码成 `%7B...%7D`，Stripe 不再替换它，
 * 返回侧的确认端点拿一个字面量去查行、查不到答 404，即时到账整条路静默
 * 失效——而 webhook 照样让积分到账，所以这个失效在验证里看不见。
 *
 * 二、**`payment.id` 在建 session 之前就得生成**。它要拼进 `cancel_url`，
 * 买家点返回时靠它找到那一行。倒过来做（先插行、`stripe_session_id` 留空
 * 回填）的话，`sessions.create` 抛一次错就留下一行 session id 为空的
 * `pending`：三条转 `expired` 的路径全都够不着它，对账捞到它却拿空值去
 * retrieve，买家看到一行永久「处理中」。
 *
 * 三、**`time_zone` 来自客户端，不可信**。它进 `payments.metadata`，确认
 * 邮件按它换算购买时刻，认不出来就兜底 UTC。
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  inject,
  vi,
} from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

const stripe = {
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

import postgres from "postgres";
import { initCore, loadLocales, MONOREPO_ROOT, runWithLocale } from "@breatic/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCheckout } from "@server/modules/payment/payment.service.js";
import { CONSENT_CREDITS_VERSION } from "@server/modules/payment/legal-text.js";

/**
 * 该语言的积分同意文案，直接从语言文件读。
 *
 * 断言的是「发给 Stripe 的那句话，就是语言文件里该语言那一条」。绕开
 * `t()` 自己读文件，是为了让这条断言在 i18n 那一层出问题时也照样红。
 * @param locale - 语言。
 * @returns 那一条文案。
 */
function consentText(locale: string): string {
  const raw = readFileSync(resolve(MONOREPO_ROOT, `locales/${locale}.json`), "utf-8");
  const tree = JSON.parse(raw) as {
    server: { payment: Record<string, string> };
  };
  return tree.server.payment[CONSENT_CREDITS_VERSION]!;
}

/**
 * 用某个语言发起一次结账。
 *
 * 生产路径上语言由 `localeMiddleware` 从 `Accept-Language` 协商出来、用
 * `runWithLocale` 钉在这次请求上，`createCheckout` 自己读它。这里照同一条
 * 路走，免得测试拿到一条生产代码里不存在的传参路径。
 * @param input - 买谁的、买哪一档、从哪来、什么语言。
 * @returns 那一行的 id 与结账地址。
 */
async function checkout(input: {
  userId: string;
  priceCents: number;
  returnUrl: string;
  timeZone: string;
  locale: string;
}): Promise<{ paymentId: string; url: string }> {
  const { locale, ...rest } = input;
  return runWithLocale(locale, () => createCheckout(rest));
}

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "topup-checkout-test" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  stripe.checkout.sessions.create.mockResolvedValue({
    id: "cs_test_created",
    url: "https://checkout.stripe.com/c/pay/cs_test_created",
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** An account to buy with. */
async function seedUser(): Promise<string> {
  seq += 1;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`checkout-${Date.now()}-${seq}@example.test`}, true) RETURNING id
  `;
  return user!.id;
}

/** Removes an account and its payments. */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM payments WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

/** The single argument `sessions.create` was called with. */
function sessionArg(): Record<string, unknown> {
  const [arg] = stripe.checkout.sessions.create.mock.calls[0] as [
    Record<string, unknown>,
  ];
  return arg;
}

describe("createCheckout — what reaches Stripe", () => {
  it("asks for the consent tick and carries the buyer's own wording", async () => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 2000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "Asia/Shanghai",
        locale: "zh-CN",
      });

      const arg = sessionArg();
      expect(arg["consent_collection"]).toEqual({
        terms_of_service: "required",
      });
      expect(arg["custom_text"]).toEqual({
        terms_of_service_acceptance: {
          message: consentText("zh-CN"),
        },
      });
    } finally {
      await dropUser(userId);
    }
  });

  it.each([
    ["en", "en"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh-TW"],
    ["ja", "ja"],
    ["ko", "ko"],
  ])("renders the page in %s, which Stripe spells %s", async (ours, theirs) => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 1000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "UTC",
        locale: ours,
      });

      const arg = sessionArg();
      expect(arg["locale"]).toBe(theirs);
      expect(
        (arg["custom_text"] as { terms_of_service_acceptance: { message: string } })
          .terms_of_service_acceptance.message,
      ).toBe(consentText(ours));
    } finally {
      await dropUser(userId);
    }
  });

  it("has Stripe work out the tax, and lets the session go stale in two hours", async () => {
    const userId = await seedUser();
    const before = Math.floor(Date.now() / 1000);
    try {
      await checkout({
        userId,
        priceCents: 5000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "UTC",
        locale: "en",
      });

      const arg = sessionArg();
      expect(arg["automatic_tax"]).toEqual({ enabled: true });

      const expiresAt = arg["expires_at"] as number;
      const twoHours = 2 * 60 * 60;
      expect(expiresAt).toBeGreaterThanOrEqual(before + twoHours - 5);
      expect(expiresAt).toBeLessThanOrEqual(before + twoHours + 30);
    } finally {
      await dropUser(userId);
    }
  });

  it("sends the session-id placeholder through unencoded", async () => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 1000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "UTC",
        locale: "en",
      });

      const successUrl = sessionArg()["success_url"] as string;
      expect(successUrl).toContain("session_id={CHECKOUT_SESSION_ID}");
      expect(successUrl).not.toContain("%7B");
      expect(successUrl).toContain("credits=1");
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the placeholder unencoded when the return URL brings its own query", async () => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 1000,
        returnUrl: "https://app.example.test/s/mine?tab=credits",
        timeZone: "UTC",
        locale: "en",
      });

      const successUrl = sessionArg()["success_url"] as string;
      expect(successUrl).toContain("session_id={CHECKOUT_SESSION_ID}");
      expect(successUrl).not.toContain("%7B");
      expect(successUrl).toContain("tab=credits");
    } finally {
      await dropUser(userId);
    }
  });

  it("points the back button at the row it is about to write", async () => {
    const userId = await seedUser();
    try {
      const result = await checkout({
        userId,
        priceCents: 1000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "UTC",
        locale: "en",
      });

      const cancelUrl = new URL(sessionArg()["cancel_url"] as string);
      expect(cancelUrl.searchParams.get("cancelled")).toBe("1");
      expect(cancelUrl.searchParams.get("credits")).toBe("1");

      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM payments WHERE user_id = ${userId}
      `;
      expect(cancelUrl.searchParams.get("payment_id")).toBe(row!.id);
      expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_test_created");
    } finally {
      await dropUser(userId);
    }
  });

  it("carries the four things a webhook cannot work out for itself", async () => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 2000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "Asia/Tokyo",
        locale: "ja",
      });

      const [row] = await sql<{ metadata: Record<string, string> }[]>`
        SELECT metadata FROM payments WHERE user_id = ${userId}
      `;
      expect(row!.metadata["locale"]).toBe("ja");
      expect(row!.metadata["timeZone"]).toBe("Asia/Tokyo");
      expect(row!.metadata["consentTextVersion"]).toBe(CONSENT_CREDITS_VERSION);
      expect(row!.metadata["refundTextVersion"]).toBe("refund-credits-v1");
    } finally {
      await dropUser(userId);
    }
  });

  it("falls back to UTC when the browser names a zone we do not know", async () => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 1000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "Mars/Olympus_Mons",
        locale: "en",
      });

      const [row] = await sql<{ metadata: Record<string, string> }[]>`
        SELECT metadata FROM payments WHERE user_id = ${userId}
      `;
      expect(row!.metadata["timeZone"]).toBe("UTC");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("createCheckout — what lands in our own table", () => {
  it("writes no row at all when Stripe refuses the session", async () => {
    const userId = await seedUser();
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Error("card_declined"),
    );
    try {
      await expect(
        checkout({
          userId,
          priceCents: 1000,
          returnUrl: "https://app.example.test/s/mine",
          timeZone: "UTC",
          locale: "en",
        }),
      ).rejects.toThrow();

      const rows = await sql`SELECT id FROM payments WHERE user_id = ${userId}`;
      expect(rows).toHaveLength(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("names the pack by face value, and records what that pack grants", async () => {
    const userId = await seedUser();
    try {
      await checkout({
        userId,
        priceCents: 50000,
        returnUrl: "https://app.example.test/s/mine",
        timeZone: "UTC",
        locale: "en",
      });

      const [row] = await sql<
        {
          amount_cents: number;
          credits_granted: string;
          status: string;
          stripe_session_id: string;
        }[]
      >`
        SELECT amount_cents, credits_granted, status, stripe_session_id
        FROM payments WHERE user_id = ${userId}
      `;
      expect(row!.amount_cents).toBe(50000);
      expect(Number(row!.credits_granted)).toBe(43660);
      expect(row!.status).toBe("pending");
      expect(row!.stripe_session_id).toBe("cs_test_created");
    } finally {
      await dropUser(userId);
    }
  });

  it("refuses a face value no pack carries", async () => {
    const userId = await seedUser();
    try {
      await expect(
        checkout({
          userId,
          priceCents: 1234,
          returnUrl: "https://app.example.test/s/mine",
          timeZone: "UTC",
          locale: "en",
        }),
      ).rejects.toThrow();
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally {
      await dropUser(userId);
    }
  });
});
