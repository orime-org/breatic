// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one tier card offers, for one selected period (#253, design 3.2).
 *
 * Ten conditions, the first match winning. They are a function rather than
 * conditions spread through the markup because both what the card shows and
 * what the server accepts have to agree: a card drawn where `changePlan`
 * refuses is an entrance into an error, and a card left blank where it
 * accepts is a purchase nobody can make.
 *
 * "Holding" is the account's tier and the stored period together, AND only
 * while the subscription is one that can still be acted on. The extra
 * condition is not decoration: a first invoice that has not settled leaves a
 * subscription row with a period while the account is still on `base`, and
 * without it the Starter card reads as "current" and that badge flickers with
 * the period switcher.
 */

import { describe, it, expect } from "vitest";
import {
  cardAction,
  type CardActionInput,
} from "@shared/types/membership.js";

/** The common case: an account paying monthly for PRO, nothing pending. */
function holding(over: Partial<CardActionInput> = {}): CardActionInput {
  return {
    card: "pro",
    selectedPeriod: "month",
    accountTier: "pro",
    sellsSubscriptions: true,
    situation: "active",
    heldPeriod: "month",
    move: "offered",
    ...over,
  };
}

describe("cardAction — the deployment and the card itself", () => {
  it("offers the sales conversation on the enterprise card, whatever else is true", () => {
    // Rule 1 sits above rule 2 on purpose: a deployment that sells no
    // subscriptions still shows this card, because it sells nothing either.
    expect(
      cardAction({ ...holding(), card: "enterprise", sellsSubscriptions: false }),
    ).toBe("contactSales");
  });

  it("leaves every other card blank when this deployment sells nothing", () => {
    for (const card of ["base", "pro", "team"] as const) {
      expect(cardAction({ ...holding(), card, sellsSubscriptions: false })).toBe(
        "blank",
      );
    }
  });
});

describe("cardAction — the card the account is on", () => {
  it("marks it current when the tier AND the selected period both match", () => {
    expect(cardAction(holding())).toBe("current");
  });

  it("stops marking it current once the switcher moves to the other period", () => {
    // The account holds PRO monthly. On the yearly view this card is not what
    // they have, and it is not reachable either: yearly is longer, so rule 7
    // does not fire — rule 9 does, and this card offers the move.
    expect(cardAction({ ...holding(), selectedPeriod: "year" })).toBe("move");
  });

  it("refuses to call it current while the first payment has not settled", () => {
    // The row exists and carries a period, and the account is still on base.
    expect(
      cardAction({
        ...holding(),
        accountTier: "base",
        situation: "firstPaymentUnsettled",
      }),
    ).toBe("choose");
  });
});

describe("cardAction — an account with nothing to act on", () => {
  it("offers a fresh checkout when there is no subscription", () => {
    expect(
      cardAction({
        ...holding(),
        accountTier: "base",
        situation: "none",
        heldPeriod: null,
      }),
    ).toBe("choose");
  });

  it("offers a fresh checkout out of a state we never create", () => {
    // `unexpected` has bought nothing, same as `none`. The server's own gate
    // refuses this when a live subscription really exists.
    expect(
      cardAction({ ...holding(), accountTier: "base", situation: "unexpected" }),
    ).toBe("choose");
  });

  it("leaves the free card blank rather than selling it", () => {
    expect(
      cardAction({
        ...holding(),
        card: "base",
        accountTier: "base",
        situation: "none",
        heldPeriod: null,
      }),
    ).toBe("blank");
  });
});

describe("cardAction — moves the product does not sell", () => {
  it("leaves a lower tier blank", () => {
    expect(
      cardAction({
        ...holding(),
        card: "pro",
        accountTier: "team",
        selectedPeriod: "month",
      }),
    ).toBe("blank");
  });

  it("leaves every card blank when the switcher shortens the period", () => {
    // Holding PRO yearly and looking at the monthly view: PRO is no longer
    // current (rule 3 needs both halves), and neither it nor Team can be
    // moved to, because a shorter period is never on offer.
    const yearly = { ...holding(), heldPeriod: "year" as const, selectedPeriod: "month" as const };
    expect(cardAction({ ...yearly, card: "pro" })).toBe("blank");
    expect(cardAction({ ...yearly, card: "team" })).toBe("blank");
  });
});

describe("cardAction — while a payment is in the way", () => {
  it("takes every entrance away while Stripe retries the card", () => {
    // Selling more during the retry window bills a card that is already
    // failing. The held card still reads "current"; that is not a button.
    const retrying = { ...holding(), situation: "retrying" as const, move: "withheld" as const };
    expect(cardAction({ ...retrying, card: "pro" })).toBe("current");
    expect(cardAction({ ...retrying, card: "team" })).toBe("blank");
  });

  it("shows a move already waiting on its invoice as in progress", () => {
    expect(
      cardAction({
        ...holding(),
        card: "team",
        situation: "upgradePending",
        move: "pending",
      }),
    ).toBe("inProgress");
  });
});
