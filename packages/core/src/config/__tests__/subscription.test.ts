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
import {
  subscriptionConfigSchema,
  resolvePlans,
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

describe("findOfferByPriceId", () => {
  // Every subscription Stripe reports about carries a price id and nothing
  // else of ours, so this lookup is what turns a webhook into a tier and a
  // billing period. Asserted against plans passed in: the deployment's own
  // price file is not in the repository, and a lookup that only works
  // against it is a lookup nothing can check.
  const plans = resolvePlans(validFile, false);

  it("answers both the tier and the period a price sells", () => {
    expect(findOfferByPriceId("price_test_team_y", plans)).toEqual({
      tier: "team",
      period: "year",
    });
  });

  it("answers null for a price this deployment does not sell", () => {
    expect(findOfferByPriceId("price_somebody_elses", plans)).toBeNull();
  });

  it("answers null for an empty id rather than matching an unsold period", () => {
    // Price ids are pasted in by hand, and a period nobody has created a
    // price for yet sits in the file as an empty string. Without this an
    // empty id would match whichever empty slot came first.
    const withUnsoldYearly = resolvePlans(
      {
        ...validFile,
        plans: {
          ...validFile.plans,
          pro: {
            ...validFile.plans.pro,
            periods: {
              ...validFile.plans.pro.periods,
              year: {
                ...validFile.plans.pro.periods.year,
                stripe_price_id: { test: "", live: "" },
              },
            },
          },
        },
      },
      false,
    );
    expect(findOfferByPriceId("", withUnsoldYearly)).toBeNull();
  });
});
