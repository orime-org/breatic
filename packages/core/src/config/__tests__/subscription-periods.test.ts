// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Membership plans are now sold over two billing periods (#253, design §1).
 *
 * A tier no longer names one price: it names one per period, each with its
 * own Stripe price id. Two things have to hold.
 *
 * Every tier-and-period combination must be present, and a missing one has to
 * say which is missing. An undefined price id travelling to Stripe fails in
 * front of somebody who is paying us.
 *
 * Which id is taken depends on the environment, so that a test price never
 * takes real money and a live one is never charged in development.
 *
 * What this deployment actually charges is not asserted here. Those figures
 * live in `config/subscription.yaml`, which each deployment writes for itself
 * and git does not track; the server entry loads it at boot, so a missing or
 * unfilled file stops the process rather than reaching a buyer.
 */

import { describe, it, expect } from "vitest";
import {
  SUBSCRIBABLE_MEMBERSHIP_TIERS,
  BILLING_PERIODS,
} from "@breatic/shared";
import {
  subscriptionConfigSchema,
  resolvePlans,
} from "@core/config/subscription.js";

/** A file with every tier-and-period combination filled in. */
const validFile = {
  stale_after_days: 14,
  stripe_call_timeout_ms: 5000,
  plans: {
    pro: {
      currency: "usd",
      periods: {
        month: {
          price_cents: 1999,
          stripe_price_id: { test: "price_test_pro_m", live: "price_live_pro_m" },
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
          stripe_price_id: { test: "price_test_team_m", live: "price_live_team_m" },
        },
        year: {
          price_cents: 79999,
          stripe_price_id: { test: "price_test_team_y", live: "price_live_team_y" },
        },
      },
    },
  },
};

describe("subscription config — the shape carries both periods", () => {
  it("resolves one plan per tier and period", () => {
    const plans = resolvePlans(subscriptionConfigSchema.parse(validFile), false);
    for (const tier of SUBSCRIBABLE_MEMBERSHIP_TIERS) {
      for (const period of BILLING_PERIODS) {
        expect(plans[tier][period].stripePriceId).toBe(
          `price_test_${tier}_${period[0]}`,
        );
      }
    }
  });

  it("names the tier AND the period when a combination is missing", () => {
    const withoutAnnualTeam = structuredClone(validFile);
    // @ts-expect-error deleting a required key is the whole point of this case
    delete withoutAnnualTeam.plans.team.periods.year;
    // Parsing and resolving run together: which of the two layers catches it
    // depends on whether a whole tier or one of its periods went missing, and
    // the reader only cares that the complaint names what is missing.
    expect(() =>
      resolvePlans(subscriptionConfigSchema.parse(withoutAnnualTeam), false),
    ).toThrow(/team[\s\S]*year|year[\s\S]*team/);
  });

  it("names the tier when a whole tier is missing", () => {
    const withoutTeam = structuredClone(validFile);
    // @ts-expect-error the loose record makes a missing tier resolvable-shaped
    delete withoutTeam.plans.team;
    expect(() =>
      resolvePlans(subscriptionConfigSchema.parse(withoutTeam), false),
    ).toThrow(/team/);
  });

  it("takes the live id in production and the test id everywhere else", () => {
    const parsed = subscriptionConfigSchema.parse(validFile);
    expect(resolvePlans(parsed, true).pro.year.stripePriceId).toBe(
      "price_live_pro_y",
    );
    expect(resolvePlans(parsed, false).pro.year.stripePriceId).toBe(
      "price_test_pro_y",
    );
  });
});
