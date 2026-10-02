// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The note that tells the model when, on the reader's own clock, a message
 * was sent. Every expected line is written out in full, so the text the model
 * reads cannot change with the ICU data a Node release carries.
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

  it("writes a zero offset with its hours and minutes", () => {
    expect(readerClockNote(AT, "UTC")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 09:27 (UTC, GMT+00:00).]",
    );
    expect(readerClockNote(new Date("2026-01-15T00:05:00Z"), "Europe/London")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-01-15 00:05 (Europe/London, GMT+00:00).]",
    );
  });

  it("writes an offset that is not a whole hour", () => {
    expect(readerClockNote(AT, "Asia/Kolkata")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 14:57 (Asia/Kolkata, GMT+05:30).]",
    );
    expect(readerClockNote(AT, "America/St_Johns")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 06:57 (America/St_Johns, GMT-02:30).]",
    );
  });

  it("keeps the offset whole late in a minute", () => {
    expect(readerClockNote(new Date("2026-10-01T09:27:59.900Z"), "Asia/Shanghai")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 17:27 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("moves to the next day when the reader's clock already has", () => {
    expect(readerClockNote(new Date("2026-10-01T16:30:00Z"), "Asia/Shanghai")).toBe(
      "[The reader's local time when they sent this message: Friday, 2026-10-02 00:30 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("writes the zone as the browser reported it", () => {
    expect(readerClockNote(AT, "Asia/Calcutta")).toBe(
      "[The reader's local time when they sent this message: Thursday, 2026-10-01 14:57 (Asia/Calcutta, GMT+05:30).]",
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
