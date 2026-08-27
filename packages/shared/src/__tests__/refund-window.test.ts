// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund window — the one arithmetic both the confirmation email and the
 * refunds screen read.
 *
 * The rule it encodes: a purchase can be refunded within 30 UTC calendar days
 * of being paid for, the thirtieth day included in full. Both readers state
 * that rule to the buyer, so they have to agree on which day it lands on —
 * an email naming one date while the screen has already dropped the purchase
 * is the same rule told two ways.
 */

import { describe, it, expect } from "vitest";
import {
  refundWindowCloses,
  withinRefundWindow,
} from "@shared/refund-window.js";

describe("the instant the refund window closes", () => {
  it("is the last millisecond of the thirtieth UTC day", () => {
    expect(
      refundWindowCloses(new Date("2026-08-01T10:00:00.000Z")).toISOString(),
    ).toBe("2026-08-31T23:59:59.999Z");
  });

  // The time of day a purchase was made does not shorten or lengthen its
  // window: both of these close at the same instant.
  it("does not carry the purchase's own time of day", () => {
    expect(
      refundWindowCloses(new Date("2026-08-01T00:00:00.000Z")).toISOString(),
    ).toBe("2026-08-31T23:59:59.999Z");
    expect(
      refundWindowCloses(new Date("2026-08-01T23:59:59.999Z")).toISOString(),
    ).toBe("2026-08-31T23:59:59.999Z");
  });

  it("crosses a month", () => {
    expect(
      refundWindowCloses(new Date("2026-08-20T12:00:00.000Z")).toISOString(),
    ).toBe("2026-09-19T23:59:59.999Z");
  });

  it("crosses a year", () => {
    expect(
      refundWindowCloses(new Date("2026-12-20T12:00:00.000Z")).toISOString(),
    ).toBe("2027-01-19T23:59:59.999Z");
  });

  // Every date this arithmetic produces is padded to two digits. A single
  // digit left bare gives a string `Date` refuses outright, and the day-of-
  // month is the half that reaches single digits soonest.
  it("pads a single-digit day", () => {
    const closes = refundWindowCloses(new Date("2026-08-05T10:00:00.000Z"));
    expect(closes.getTime()).not.toBeNaN();
    expect(closes.toISOString()).toBe("2026-09-04T23:59:59.999Z");
  });

  it("crosses the end of February in a leap year", () => {
    expect(
      refundWindowCloses(new Date("2028-02-10T12:00:00.000Z")).toISOString(),
    ).toBe("2028-03-11T23:59:59.999Z");
  });

  // Read in the buyer's own zone this instant is a wall-clock time on one side
  // or the other of the UTC date — which is exactly why the confirmation email
  // prints it in both.
  it("reads east of UTC as the following morning", () => {
    const closes = refundWindowCloses(new Date("2026-08-01T10:00:00.000Z"));
    expect(
      new Intl.DateTimeFormat("en", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(closes),
    ).toMatch(/9\/1\/26/);
  });

  it("reads west of UTC as the afternoon of the same day", () => {
    const closes = refundWindowCloses(new Date("2026-08-01T10:00:00.000Z"));
    expect(
      new Intl.DateTimeFormat("en", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Los_Angeles",
      }).format(closes),
    ).toMatch(/8\/31\/26/);
  });
});

describe("whether a purchase is still inside the window", () => {
  const paidAt = "2026-08-01T10:00:00.000Z";

  it("is open the moment the purchase is made", () => {
    expect(withinRefundWindow(paidAt, new Date(paidAt))).toBe(true);
  });

  it("is open all through the thirtieth day, up to its last millisecond", () => {
    expect(
      withinRefundWindow(paidAt, new Date("2026-08-31T00:00:00.000Z")),
    ).toBe(true);
    expect(
      withinRefundWindow(paidAt, new Date("2026-08-31T23:59:59.999Z")),
    ).toBe(true);
  });

  it("is shut the moment the thirty-first day starts", () => {
    expect(
      withinRefundWindow(paidAt, new Date("2026-09-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("reads the days in UTC, not wherever the reader is", () => {
    // 09-01 08:00 in UTC+8 is 09-01 00:00 UTC — shut. The same instant read as
    // a local date would still say 08-31 in half the world.
    expect(
      withinRefundWindow(paidAt, new Date("2026-09-01T00:00:00.000Z")),
    ).toBe(false);
    // And one millisecond before it, still open.
    expect(
      withinRefundWindow(paidAt, new Date("2026-08-31T23:59:59.999Z")),
    ).toBe(true);
  });

  // The comparison is between two `YYYY-MM-DD` strings, which orders like a
  // date only while both are padded. Unpadded, "2026-09-5" sorts after
  // "2026-09-19" and a purchase inside its window reads as past it.
  it("closes on the right day when the day is a single digit", () => {
    const bought = "2026-08-05T10:00:00.000Z";
    expect(withinRefundWindow(bought, new Date("2026-09-04T23:00:00.000Z"))).toBe(
      true,
    );
    expect(withinRefundWindow(bought, new Date("2026-09-05T00:00:00.000Z"))).toBe(
      false,
    );
  });

  it("takes the purchase instant as text, keeping the microseconds the column holds", () => {
    // The API hands this straight out of `credit_lots.created_at`, which keeps
    // microseconds a `Date` cannot. Only the calendar day matters here, so the
    // extra digits have to parse rather than throw.
    expect(
      withinRefundWindow(
        "2026-08-01T10:00:00.123456Z",
        new Date("2026-08-31T12:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
