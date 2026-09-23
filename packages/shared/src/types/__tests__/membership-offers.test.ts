// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which membership offer an account may move to (#253, design section 2).
 *
 * The ratified decision lists three rows of permitted moves. This asserts the
 * whole 4 x 4 grid instead, because a list has to be remembered and a rule
 * does not: a fourth tier grows the grid by itself, while a list would stay
 * the size somebody last typed it.
 *
 * The rule is the ratified reason restated: dropping a tier or shortening a
 * period both leave us holding more money than the new offer is worth, and
 * membership is never refunded, so neither direction exists.
 */

import { describe, it, expect } from "vitest";
import {
  canMoveTo,
  type MembershipOffer,
} from "@shared/types/membership.js";

const PRO_MONTH: MembershipOffer = { tier: "pro", period: "month" };
const PRO_YEAR: MembershipOffer = { tier: "pro", period: "year" };
const TEAM_MONTH: MembershipOffer = { tier: "team", period: "month" };
const TEAM_YEAR: MembershipOffer = { tier: "team", period: "year" };

/** Every offer, in the order the grid below reads them. */
const OFFERS = [
  { name: "PRO monthly", offer: PRO_MONTH },
  { name: "PRO annual", offer: PRO_YEAR },
  { name: "Team monthly", offer: TEAM_MONTH },
  { name: "Team annual", offer: TEAM_YEAR },
] as const;

/**
 * The permitted grid, rows = held, columns = wanted, in OFFERS order.
 *
 * Written out rather than computed, so that a rule which quietly stops
 * matching the ratified table is a failure here rather than a tautology.
 */
const PERMITTED: readonly (readonly boolean[])[] = [
  //        PRO/m  PRO/y  Team/m Team/y
  /* PRO/m  */ [false, true, true, true],
  /* PRO/y  */ [false, false, false, true],
  /* Team/m */ [false, false, false, true],
  /* Team/y */ [false, false, false, false],
];

describe("canMoveTo", () => {
  for (const [row, from] of OFFERS.entries()) {
    for (const [column, to] of OFFERS.entries()) {
      const permitted = PERMITTED[row]?.[column] ?? false;
      it(`${permitted ? "allows" : "refuses"} ${from.name} to ${to.name}`, () => {
        expect(canMoveTo(from.offer, to.offer)).toBe(permitted);
      });
    }
  }

  it("refuses an offer to itself, which is what the same-tier answer is for", () => {
    for (const { offer } of OFFERS) {
      expect(canMoveTo(offer, offer)).toBe(false);
    }
  });

  it("matches the three rows of the ratified table exactly", () => {
    // The ratified decision (2026-07-30 membership tiers, "change of tier and
    // period") lists what each held offer may move to, in OFFERS order. Team
    // annual has no row there at all, which is the empty list below.
    const ratified: readonly (readonly string[])[] = [
      ["PRO annual", "Team monthly", "Team annual"],
      ["Team annual"],
      ["Team annual"],
      [],
    ];
    for (const [row, from] of OFFERS.entries()) {
      const reachable = OFFERS.filter((to) =>
        canMoveTo(from.offer, to.offer),
      ).map((to) => to.name);
      expect(reachable).toEqual(ratified[row]);
    }
  });
});
