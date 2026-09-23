// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { refundRefusal } from "@shared/refund-eligibility.js";
import type { RefundCandidate } from "@shared/refund-eligibility.js";

/** A day inside the window of a purchase made on the first. */
const NOW = new Date("2026-01-10T12:00:00.000Z");

/** A day past the window of a purchase made on the first. */
const LATE = new Date("2026-03-01T12:00:00.000Z");

/**
 * A purchase that can be asked about, with one field replaced.
 * @param over - What to change.
 * @returns The purchase.
 */
function lot(over: Partial<RefundCandidate> = {}): RefundCandidate {
  return {
    lifecycle: "active",
    purchased: true,
    designated: false,
    everSpent: false,
    refundAttempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("refundRefusal", () => {
  it("allows an untouched, unassigned purchase inside its window", () => {
    expect(refundRefusal(lot(), NOW)).toBeNull();
  });

  it("refuses credits nobody paid for", () => {
    expect(refundRefusal(lot({ purchased: false }), NOW)).toBe("not_purchased");
  });

  it("answers that before anything about where the credits stand", () => {
    // The other four say what has happened to these credits; this one says
    // what they are. A granted lot that was spent to nothing and has sat past
    // the window is refused for what it is, not for either of those — there
    // is no state it could reach that would make a refund of it possible.
    expect(
      refundRefusal(
        lot({
          purchased: false,
          lifecycle: "depleted",
          everSpent: true,
          designated: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        LATE,
      ),
    ).toBe("not_purchased");
  });

  it.each(["refund_pending", "refunding", "refunded"] as const)(
    "refuses one already on its way out: %s",
    (lifecycle) => {
      expect(refundRefusal(lot({ lifecycle }), NOW)).toBe("already_asked");
    },
  );

  it("refuses one still pointed at a studio", () => {
    expect(refundRefusal(lot({ designated: true }), NOW)).toBe(
      "still_designated",
    );
  });

  it("answers with the spending before the designation", () => {
    // Unassigning is the one thing a buyer can do about a refusal, so it is
    // worth saying only when it would work. Naming it on a purchase that has
    // been spent from sends them to undo a designation for nothing.
    expect(
      refundRefusal(
        lot({ designated: true, everSpent: true }),
        NOW,
      ),
    ).toBe("already_spent");
  });

  it("answers with the closed window before the designation", () => {
    expect(
      refundRefusal(lot({ designated: true }), LATE),
    ).toBe("window_closed");
  });

  it("refuses one that has been spent from", () => {
    expect(refundRefusal(lot({ everSpent: true }), NOW)).toBe("already_spent");
  });

  it("refuses a depleted purchase on the ledger, not on the lifecycle", () => {
    expect(refundRefusal(lot({ lifecycle: "depleted", everSpent: true }), NOW))
      .toBe("already_spent");
  });

  it("refuses a first ask made past the window", () => {
    expect(refundRefusal(lot(), LATE)).toBe("window_closed");
  });

  it("allows a second ask past the window, the first having been in time", () => {
    expect(refundRefusal(lot({ refundAttempts: 1 }), LATE)).toBeNull();
  });

  it("answers with the spending before the closed window", () => {
    // A pack both spent from and older than thirty days fails two conditions.
    // Spending is the one that is said, because it is the one that would still
    // refuse the ask if the window were open — the window alone would not.
    expect(refundRefusal(lot({ everSpent: true }), LATE)).toBe("already_spent");
  });

  it("still refuses a spent purchase that was asked about before", () => {
    expect(
      refundRefusal(lot({ refundAttempts: 1, everSpent: true }), LATE),
    ).toBe("already_spent");
  });
});
