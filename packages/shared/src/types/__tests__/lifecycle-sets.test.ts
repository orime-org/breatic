// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three lifecycle groupings answer three different questions about the
 * same five states, and one of them — `IN_FLIGHT_REFUND_LIFECYCLES` — is
 * defined by its relation to the other two. Prose cannot hold a relation:
 * adding a sixth lifecycle, or moving one between groups, leaves every
 * sentence reading exactly as before while the figures they describe go
 * apart. These assertions are where the relations are kept.
 */

import { describe, expect, it } from "vitest";

import {
  HELD_LIFECYCLES,
  IN_FLIGHT_REFUND_LIFECYCLES,
} from "@shared/types/credit.js";
import { REFUND_LIFECYCLES } from "@shared/refund-eligibility.js";
import type { CreditLotLifecycle } from "@shared/types/entities.js";

/** Every state a lot can be in, which the database CHECK also lists. */
const EVERY_LIFECYCLE: readonly CreditLotLifecycle[] = [
  "active",
  "depleted",
  "refund_pending",
  "refunding",
  "refunded",
];

describe("the three lifecycle groupings", () => {
  it("names only lifecycles that exist", () => {
    for (const lifecycle of [
      ...HELD_LIFECYCLES,
      ...IN_FLIGHT_REFUND_LIFECYCLES,
      ...REFUND_LIFECYCLES,
    ]) {
      expect(EVERY_LIFECYCLE).toContain(lifecycle);
    }
  });

  it("holds the in-flight refunds as exactly what is both held and refunding", () => {
    const heldAndRefunding = EVERY_LIFECYCLE.filter(
      (lifecycle) =>
        HELD_LIFECYCLES.includes(lifecycle) && REFUND_LIFECYCLES.has(lifecycle),
    );

    expect([...IN_FLIGHT_REFUND_LIFECYCLES].sort()).toEqual(
      heldAndRefunding.sort(),
    );
  });

  it("counts a lot as held right up to the moment the money goes back", () => {
    // `refunded` is the one refund lifecycle the buyer no longer holds: the
    // money has left. The other two are still theirs, which is why the
    // overview's three figures sum to everything bought and not yet spent.
    expect(HELD_LIFECYCLES).not.toContain("refunded");
    expect(HELD_LIFECYCLES).toContain("refund_pending");
    expect(HELD_LIFECYCLES).toContain("refunding");
  });

  it("leaves a spent-out lot out of what is held", () => {
    // `depleted` is neither held nor on its way out — it is simply spent.
    expect(HELD_LIFECYCLES).not.toContain("depleted");
    expect(REFUND_LIFECYCLES.has("depleted")).toBe(false);
  });

  it("puts every refund lifecycle on the way out of the account", () => {
    expect([...REFUND_LIFECYCLES].sort()).toEqual(
      ["refund_pending", "refunded", "refunding"].sort(),
    );
  });
});
