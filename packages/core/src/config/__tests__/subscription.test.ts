// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
  findSubscribableTierByPriceId,
} from "@core/config/subscription.js";

const validFile = {
  plans: {
    pro: {
      price_cents: 1200,
      currency: "usd",
      stripe_price_id: { test: "price_test_pro", live: "price_live_pro" },
    },
    team: {
      price_cents: 3900,
      currency: "usd",
      stripe_price_id: { test: "price_test_team", live: "price_live_team" },
    },
  },
};

describe("subscription config — schema", () => {
  it("accepts a file carrying every subscribable tier", () => {
    const parsed = subscriptionConfigSchema.parse(validFile);
    expect(parsed.plans.pro?.price_cents).toBe(1200);
  });

  it("rejects a price that is not a positive integer", () => {
    expect(() =>
      subscriptionConfigSchema.parse({
        plans: { pro: { ...validFile.plans.pro, price_cents: 0 } },
      }),
    ).toThrow();
  });
});

describe("subscription config — resolving plans", () => {
  it("names the tier whose plan is missing", () => {
    // A missing plan must not be discovered at checkout time as an undefined
    // price id sent to Stripe.
    expect(() =>
      resolvePlans({ plans: { pro: validFile.plans.pro } }, false),
    ).toThrow(/team/);
  });

  it("takes the test price id outside production", () => {
    expect(resolvePlans(validFile, false).pro.stripePriceId).toBe(
      "price_test_pro",
    );
  });

  it("takes the live price id in production", () => {
    expect(resolvePlans(validFile, true).team.stripePriceId).toBe(
      "price_live_team",
    );
  });

  it("carries the price and currency through unchanged", () => {
    const plans = resolvePlans(validFile, false);
    expect(plans.team.priceCents).toBe(3900);
    expect(plans.team.currency).toBe("usd");
  });
});

describe("subscription config — reads config/subscription.yaml", () => {
  it("ships a plan for every subscribable tier", () => {
    const plans = getSubscriptionPlans();
    for (const tier of SUBSCRIBABLE_MEMBERSHIP_TIERS) {
      expect(plans[tier].priceCents).toBeGreaterThan(0);
      expect(plans[tier].stripePriceId).not.toBe("");
    }
  });

  it("carries the ratified monthly prices", () => {
    // $12 and $39 (marketing decision 2026-07-30). Asserted against the file
    // rather than against each other, so a swap of the two rows fails here.
    expect(getSubscriptionPlan("pro").priceCents).toBe(1200);
    expect(getSubscriptionPlan("team").priceCents).toBe(3900);
  });

  it("reads the price ids the file really carries, for this environment", () => {
    const raw = parse(
      readFileSync(resolve(MONOREPO_ROOT, "config/subscription.yaml"), "utf-8"),
    ) as typeof validFile;
    const ids = raw.plans.pro.stripe_price_id;
    expect(getSubscriptionPlan("pro").stripePriceId).toBe(
      env.ENV === "prod" ? ids.live : ids.test,
    );
  });

  it("carries the window a lapsed subscription is honoured for", () => {
    // Stripe's own Smart Retries default is two weeks; shorter would take the
    // tier away from somebody whose card is still being retried.
    expect(getSubscriptionStaleAfterDays()).toBe(14);
  });

  it("maps a price id back to the tier it sells", () => {
    const proPriceId = getSubscriptionPlan("pro").stripePriceId;
    expect(findSubscribableTierByPriceId(proPriceId)).toBe("pro");
    expect(findSubscribableTierByPriceId("price_nothing")).toBeNull();
  });
});
