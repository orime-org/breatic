// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 订阅计划配置（#106 §12）。
 *
 * 两件事要钉住：一是每个可订阅档位都必须在文件里有一条计划、缺了要指名报错，
 * 二是 test / live 两个 price id 按环境选对 —— 选错了会拿测试的 id 去真实
 * 收款，或者反过来在开发环境刷真卡。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { SUBSCRIBABLE_MEMBERSHIP_TIERS } from "@breatic/shared";
import { env, MONOREPO_ROOT } from "@core/config/env.js";
import {
  subscriptionConfigSchema,
  resolvePlans,
  getSubscriptionPlans,
  getSubscriptionPlan,
  getSubscriptionStaleAfterDays,
  findOfferByPriceId,
} from "@core/config/subscription.js";

const validFile = {
  stale_after_days: 14,
  stripe_call_timeout_ms: 5000,
  plans: {
    pro: {
      currency: "usd",
      periods: {
        month: {
          price_cents: 1999,
          stripe_price_id: { test: "price_test_pro", live: "price_live_pro" },
        },
        year: {
          price_cents: 19999,
          stripe_price_id: { test: "price_test_pro_y", live: "price_live_pro_y" },
        },
      },
    },
    team: {
      currency: "usd",
      periods: {
        month: {
          price_cents: 7999,
          stripe_price_id: { test: "price_test_team", live: "price_live_team" },
        },
        year: {
          price_cents: 79999,
          stripe_price_id: { test: "price_test_team_y", live: "price_live_team_y" },
        },
      },
    },
  },
};

describe("subscription config — schema", () => {
  it("accepts a file carrying every subscribable tier", () => {
    const parsed = subscriptionConfigSchema.parse(validFile);
    expect(parsed.plans.pro?.periods.month.price_cents).toBe(1999);
  });

  it("rejects a price that is not a positive integer", () => {
    expect(() =>
      subscriptionConfigSchema.parse({
        plans: {
          pro: {
            ...validFile.plans.pro,
            periods: {
              ...validFile.plans.pro.periods,
              month: { ...validFile.plans.pro.periods.month, price_cents: 0 },
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe("subscription config — resolving plans", () => {
  it("names the tier whose plan is missing", () => {
    // A missing plan must not be discovered at checkout time as an undefined
    // price id sent to Stripe.
    expect(() =>
      resolvePlans(
        {
          stale_after_days: 14,
          stripe_call_timeout_ms: 5000,
          plans: { pro: validFile.plans.pro },
        },
        false,
      ),
    ).toThrow(/team/);
  });

  it("takes the test price id outside production", () => {
    expect(resolvePlans(validFile, false).pro.month.stripePriceId).toBe(
      "price_test_pro",
    );
  });

  it("takes the live price id in production", () => {
    expect(resolvePlans(validFile, true).team.month.stripePriceId).toBe(
      "price_live_team",
    );
  });

  it("carries the price and currency through unchanged", () => {
    const plans = resolvePlans(validFile, false);
    expect(plans.team.month.priceCents).toBe(7999);
    expect(plans.team.month.currency).toBe("usd");
  });
});

describe("subscription config — reads config/subscription.yaml", () => {
  it("ships a priced plan for every tier and period", () => {
    const plans = getSubscriptionPlans();
    for (const tier of SUBSCRIBABLE_MEMBERSHIP_TIERS) {
      expect(plans[tier].month.priceCents).toBeGreaterThan(0);
      expect(plans[tier].year.priceCents).toBeGreaterThan(0);
    }
  });

  it("still has no price id for the annual plans nobody has created yet", () => {
    // The eight Stripe prices are created by hand before launch (design 1.1).
    // Asserting the gap keeps it visible: when the annual ones arrive this
    // goes red, which is the reminder to fill the file in.
    const plans = getSubscriptionPlans();
    for (const tier of SUBSCRIBABLE_MEMBERSHIP_TIERS) {
      expect(plans[tier].month.stripePriceId).not.toBe("");
      expect(plans[tier].year.stripePriceId).toBe("");
    }
  });

  it("carries the ratified monthly prices", () => {
    // $19.99 and $79.99 (marketing decision, repriced 2026-09-01). Asserted
    // against the file rather than against each other, so a swap of the two
    // rows fails here.
    expect(getSubscriptionPlan("pro", "month").priceCents).toBe(1999);
    expect(getSubscriptionPlan("team", "month").priceCents).toBe(7999);
  });

  it("reads the price ids the file really carries, for this environment", () => {
    const raw = parse(
      readFileSync(resolve(MONOREPO_ROOT, "config/subscription.yaml"), "utf-8"),
    ) as typeof validFile;
    const ids = raw.plans.pro.periods.month.stripe_price_id;
    expect(getSubscriptionPlan("pro", "month").stripePriceId).toBe(
      env.ENV === "prod" ? ids.live : ids.test,
    );
  });

  it("carries the window a lapsed subscription is honoured for", () => {
    // Stripe's own Smart Retries default is two weeks; shorter would take the
    // tier away from somebody whose card is still being retried.
    expect(getSubscriptionStaleAfterDays()).toBe(14);
  });

  it("maps a price id back to the offer it sells", () => {
    const proPriceId = getSubscriptionPlan("pro", "month").stripePriceId;
    expect(findOfferByPriceId(proPriceId)).toEqual({
      tier: "pro",
      period: "month",
    });
    expect(findOfferByPriceId("price_nothing")).toBeNull();
  });
});
