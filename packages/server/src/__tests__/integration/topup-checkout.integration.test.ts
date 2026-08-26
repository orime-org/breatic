// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Creating the checkout session (task #13 §4.2, §4.7) — real PG, Stripe client
 * doubled.
 *
 * This step produces two things, and both have to come out right in the same
 * call: the session we hand to Stripe, and our own `payments` row.
 *
 * Three places are easy to get wrong, and each has a group of cases pinning it
 * down:
 *
 * 1. **`{CHECKOUT_SESSION_ID}` has to go out verbatim.** `new URL()` together
 * with `searchParams.set()` encodes the braces as `%7B...%7D`, Stripe then no
 * longer substitutes it, and the confirmation endpoint on the return leg looks
 * the row up by a literal string, finds nothing, and answers 404 — the whole
 * instant-credit path fails silently. The webhook still grants the credits, so
 * nothing about the failure is visible from the outside.
 *
 * 2. **`payment.id` has to exist before the session is created.** It goes into
 * `cancel_url`, which is how a buyer who clicks back gets us to the right row.
 * Doing it the other way round (insert the row first, leave
 * `stripe_session_id` empty and fill it in afterwards) means one throw from
 * `sessions.create` leaves behind a `pending` row with no session id: none of
 * the three paths that move a row to `expired` can reach it, and reconciliation
 * picks it up only to retrieve on an empty value. The buyer is left with a row
 * that says "processing" forever.
 *
 * 3. **`time_zone` comes from the client and is not trusted.** It lands in
 * `payments.metadata`, and the confirmation mail converts the purchase time
 * with it; anything we do not recognise falls back to UTC.
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
import {
  createCheckout,
  listTiers,
} from "@server/modules/payment/payment.service.js";
import {
  CONSENT_CREDITS_VERSION,
  REFUND_CREDITS_VERSION,
  refundLinesAt,
} from "@server/modules/payment/legal-text.js";

/**
 * The credits consent wording for a locale, read straight from the locale file.
 *
 * What is being asserted is that the sentence we send to Stripe is the one that
 * locale's file actually carries. Reading the file directly instead of going
 * through `t()` is what keeps the assertion red when something breaks in the
 * i18n layer itself.
 * @param locale - The locale to read.
 * @returns That locale's wording.
 */
function consentText(locale: string): string {
  const raw = readFileSync(resolve(MONOREPO_ROOT, `locales/${locale}.json`), "utf-8");
  const tree = JSON.parse(raw) as {
    server: { payment: Record<string, string> };
  };
  return tree.server.payment[CONSENT_CREDITS_VERSION]!;
}

/**
 * Starts one checkout under a given locale.
 *
 * In production the locale is negotiated from `Accept-Language` by
 * `localeMiddleware`, pinned to the request with `runWithLocale`, and read back
 * by `createCheckout` itself. Going the same way here keeps the test off a
 * parameter path that does not exist in production code.
 * @param input - Who is buying, which pack, where they came from, and in what
 * locale.
 * @returns The row's id and the checkout URL.
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

describe("GET /payment/tiers — what the buy screen reads", () => {
  it("carries the wait the page is allowed to keep a buyer behind", () => {
    // The value is in the server's config and the timer runs in the browser.
    // A copy in the frontend would drift the day somebody changed it, and the
    // page would stop waiting at a moment nobody chose.
    const listed = listTiers();
    expect(listed.confirmTimeoutMs).toBeGreaterThan(0);
    expect(listed.packs).toHaveLength(5);
    expect(listed.packs[0]).toMatchObject({ priceCents: 1000, credits: 830 });
  });

  it("carries the refund rule in full, in the language of the request", () => {
    // The buy screen has to show it before a buyer agrees to it, and this is
    // that screen's only source. The wording is versioned on the server, so
    // the browser cannot hold a copy.
    const listed = listTiers();
    // The version is named here as a literal. Comparing against the same
    // constant the implementation reads would agree with itself even if the
    // constant pointed at wording no locale file has.
    expect(listed.refundLines).toEqual(refundLinesAt("refund-credits-v1", "en"));
    expect(REFUND_CREDITS_VERSION).toBe("refund-credits-v1");
    expect(listed.refundLines).toHaveLength(3);
    for (const line of listed.refundLines) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("gives that rule in whatever language the buyer is reading in", () => {
    const japanese = runWithLocale("ja", () => listTiers());
    expect(japanese.refundLines).toEqual(refundLinesAt("refund-credits-v1", "ja"));
    expect(japanese.refundLines).not.toEqual(
      refundLinesAt("refund-credits-v1", "en"),
    );
  });
});
