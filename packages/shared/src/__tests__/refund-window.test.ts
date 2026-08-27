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
  refundDeadlineDay,
  withinRefundWindow,
} from "@shared/refund-window.js";

describe("which day the refund window closes on", () => {
  it("lands thirty calendar days after the purchase", () => {
    expect(refundDeadlineDay(new Date("2026-08-01T10:00:00.000Z"))).toBe(
      "2026-08-31",
    );
  });

  it("counts days, not hours: a purchase late in the day closes on the same date as one early in it", () => {
    expect(refundDeadlineDay(new Date("2026-08-01T00:00:00.000Z"))).toBe(
      "2026-08-31",
    );
    expect(refundDeadlineDay(new Date("2026-08-01T23:59:59.999Z"))).toBe(
      "2026-08-31",
    );
  });

  it("crosses a month", () => {
    expect(refundDeadlineDay(new Date("2026-08-20T12:00:00.000Z"))).toBe(
      "2026-09-19",
    );
  });

  it("crosses a year", () => {
    expect(refundDeadlineDay(new Date("2026-12-20T12:00:00.000Z"))).toBe(
      "2027-01-19",
    );
  });

  it("crosses the end of February in a leap year", () => {
    expect(refundDeadlineDay(new Date("2028-02-10T12:00:00.000Z"))).toBe(
      "2028-03-11",
    );
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
