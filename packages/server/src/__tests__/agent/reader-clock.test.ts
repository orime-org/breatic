// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The note that tells the model when, on the reader's own clock, a message
 * was sent. Every expected line here is what Node 24's Intl produces for that
 * instant and zone.
 */
import { describe, expect, it } from "vitest";

import { readerClockNote } from "@server/agent/reader-clock.js";

const AT = new Date("2026-10-01T09:27:00Z");

describe("readerClockNote", () => {
  it("gives the reader's local date, weekday, time and zone", () => {
    expect(readerClockNote(AT, "Asia/Shanghai")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 17:27 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("follows daylight saving on either side of the change", () => {
    expect(readerClockNote(new Date("2026-03-07T17:00:00Z"), "America/New_York")).toBe(
      "[The reader's local time when they sent this message: Saturday, 2026-03-07 12:00 (America/New_York, GMT-05:00).]",
    );
    expect(readerClockNote(new Date("2026-03-09T17:00:00Z"), "America/New_York")).toBe(
      "[The reader's local time when they sent this message: Monday, 2026-03-09 13:00 (America/New_York, GMT-04:00).]",
    );
  });

  it("names a zero offset as GMT, the way Intl writes it", () => {
    expect(readerClockNote(AT, "UTC")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 09:27 (UTC, GMT).]",
    );
    expect(readerClockNote(new Date("2026-01-15T00:05:00Z"), "Europe/London")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-01-15 00:05 (Europe/London, GMT).]",
    );
  });

  it("moves to the next day when the reader's clock already has", () => {
    expect(readerClockNote(new Date("2026-10-01T16:30:00Z"), "Asia/Shanghai")).toBe(
      "[The reader's local time when they sent this message: Friday, 2026-10-02 00:30 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("writes the zone under the name Intl resolves it to", () => {
    expect(readerClockNote(AT, "asia/shanghai")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 17:27 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("falls back to UTC and says so when no zone came with the message", () => {
    expect(readerClockNote(AT, undefined)).toBe(
      "[The time when the reader sent this message: Thursday, 2026-10-01 09:27 UTC. Their time zone is unknown.]",
    );
  });

  it("falls back to UTC and says so when the zone is not one Intl knows", () => {
    expect(readerClockNote(AT, "Mars/Olympus")).toBe(
      "[The time when the reader sent this message: Thursday, 2026-10-01 09:27 UTC. Their time zone is unknown.]",
    );
  });
});
