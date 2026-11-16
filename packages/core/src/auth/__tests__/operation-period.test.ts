// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The monthly operations period (inner#1968, test spec area C, C-01 to C-09,
 * and property PT-1).
 *
 * Every period is pushed straight from the anchor: the k-th start is the
 * anchor plus k calendar months, its day clamped to the length of that month,
 * its time of day the anchor's. Periods are half-open, `[start, end)`, and all
 * arithmetic is UTC.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { periodContaining } from "../operation-period.js";

/**
 * The number of days in one UTC month.
 * @param year - The full year.
 * @param month - The zero-based month.
 * @returns Its length in days.
 */
function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The period containing `now`, as ISO strings for readable failures.
 * @param anchor - The anchor instant.
 * @param now - The instant to place.
 * @returns The start and end as ISO strings.
 */
function iso(anchor: string, now: string): { start: string; end: string } {
  const period = periodContaining(new Date(anchor), new Date(now));
  return { start: period.start.toISOString(), end: period.end.toISOString() };
}

describe("periodContaining", () => {
  it("C-01 places a time two months after a mid-month anchor in that month's period", () => {
    expect(iso("2026-01-15T09:30:00.000Z", "2026-03-20T00:00:00.000Z")).toEqual({
      start: "2026-03-15T09:30:00.000Z",
      end: "2026-04-15T09:30:00.000Z",
    });
  });

  it("C-02 clamps a 31st anchor to February's last day and returns to the 31st in March and May", () => {
    const anchor = "2027-01-31T10:00:00.000Z";
    expect(iso(anchor, "2027-02-15T00:00:00.000Z")).toEqual({ start: "2027-01-31T10:00:00.000Z", end: "2027-02-28T10:00:00.000Z" });
    expect(iso(anchor, "2027-03-01T00:00:00.000Z")).toEqual({ start: "2027-02-28T10:00:00.000Z", end: "2027-03-31T10:00:00.000Z" });
    expect(iso(anchor, "2027-04-30T11:00:00.000Z")).toEqual({ start: "2027-04-30T10:00:00.000Z", end: "2027-05-31T10:00:00.000Z" });
  });

  it("C-03 clamps a 31st anchor to the 29th of February in a leap year", () => {
    expect(iso("2028-01-31T00:00:00.000Z", "2028-02-29T12:00:00.000Z")).toEqual({
      start: "2028-02-29T00:00:00.000Z",
      end: "2028-03-31T00:00:00.000Z",
    });
  });

  it("C-04 keeps a 29 February anchor on the 28th in common years and on the 29th in leap years", () => {
    const anchor = "2024-02-29T08:00:00.000Z";
    expect(iso(anchor, "2025-02-28T09:00:00.000Z")).toEqual({ start: "2025-02-28T08:00:00.000Z", end: "2025-03-29T08:00:00.000Z" });
    expect(iso(anchor, "2028-02-29T09:00:00.000Z")).toEqual({ start: "2028-02-29T08:00:00.000Z", end: "2028-03-29T08:00:00.000Z" });
  });

  it("C-05 does not drift: a 30th anchor clamped in February is back on the 30th in March", () => {
    const anchor = "2026-01-30T00:00:00.000Z";
    expect(iso(anchor, "2026-02-28T01:00:00.000Z")).toEqual({ start: "2026-02-28T00:00:00.000Z", end: "2026-03-30T00:00:00.000Z" });
    expect(iso(anchor, "2026-03-30T01:00:00.000Z")).toEqual({ start: "2026-03-30T00:00:00.000Z", end: "2026-04-30T00:00:00.000Z" });
  });

  it("C-06 includes the start, includes the last millisecond before the end, and excludes the end", () => {
    const anchor = "2026-01-15T00:00:00.000Z";
    const february = { start: "2026-02-15T00:00:00.000Z", end: "2026-03-15T00:00:00.000Z" };
    expect(iso(anchor, "2026-02-15T00:00:00.000Z")).toEqual(february);
    expect(iso(anchor, "2026-03-14T23:59:59.999Z")).toEqual(february);
    expect(iso(anchor, "2026-03-15T00:00:00.000Z")).toEqual({ start: "2026-03-15T00:00:00.000Z", end: "2026-04-15T00:00:00.000Z" });
  });

  it("C-07 counts backwards from an anchor in the future (k = -1)", () => {
    expect(iso("2027-06-15T00:00:00.000Z", "2027-05-20T00:00:00.000Z")).toEqual({
      start: "2027-05-15T00:00:00.000Z",
      end: "2027-06-15T00:00:00.000Z",
    });
  });

  it.each([1, 15, 28, 29, 30, 31])("C-08 walks 24 periods from a January %ith anchor, each start clamped and each end the next start", (day) => {
    const anchor = new Date(Date.UTC(2026, 0, day, 13, 45, 12, 345));
    let period = periodContaining(anchor, anchor);
    for (let k = 0; k < 24; k++) {
      const year = 2026 + Math.floor(k / 12);
      const month = k % 12;
      const expected = new Date(Date.UTC(year, month, Math.min(day, daysIn(year, month)), 13, 45, 12, 345));
      expect(period.start.toISOString(), `period ${k}`).toBe(expected.toISOString());
      const next = periodContaining(anchor, period.end);
      expect(next.start.toISOString(), `end of period ${k}`).toBe(period.end.toISOString());
      period = next;
    }
  });

  it("C-09 gives a yearly subscription's anchor monthly periods, not a yearly one", () => {
    expect(iso("2026-03-10T00:00:00.000Z", "2026-07-20T00:00:00.000Z")).toEqual({
      start: "2026-07-10T00:00:00.000Z",
      end: "2026-08-10T00:00:00.000Z",
    });
  });
});

const MIN = new Date("1970-01-01T00:00:00.000Z");
const MAX = new Date("2100-12-31T23:59:59.999Z");
const anyInstant = fc.date({ min: MIN, max: MAX, noInvalidDate: true });
// Anchors on the 28th to 31st, where clamping happens.
const lateMonthAnchor = fc
  .record({
    year: fc.integer({ min: 1970, max: 2100 }),
    month: fc.integer({ min: 0, max: 11 }),
    day: fc.constantFrom(28, 29, 30, 31),
    msOfDay: fc.integer({ min: 0, max: 86_399_999 }),
  })
  .filter(({ year, month, day }) => day <= daysIn(year, month))
  .map(({ year, month, day, msOfDay }) => new Date(Date.UTC(year, month, day) + msOfDay));

/**
 * The PT-1 assertions for one anchor and instant.
 * @param anchor - The anchor.
 * @param now - The instant.
 */
function checkPeriod(anchor: Date, now: Date): void {
  const { start, end } = periodContaining(anchor, now);
  expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
  expect(now.getTime()).toBeLessThan(end.getTime());
  expect(periodContaining(anchor, end).start.getTime()).toBe(end.getTime());
  expect(periodContaining(anchor, new Date(start.getTime() - 1)).end.getTime()).toBe(start.getTime());
  expect(start.getUTCDate()).toBe(Math.min(anchor.getUTCDate(), daysIn(start.getUTCFullYear(), start.getUTCMonth())));
  expect([start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()]).toEqual([
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  ]);
}

describe("periodContaining properties (PT-1)", () => {
  it("contains now, chains end to start both ways, and keeps the anchor's clamped day and time, for any anchor", () => {
    fc.assert(fc.property(anyInstant, anyInstant, checkPeriod), { numRuns: 500 });
  });

  it("does the same for anchors on the 28th to 31st", () => {
    fc.assert(fc.property(lateMonthAnchor, anyInstant, checkPeriod), { numRuns: 500 });
  });
});
