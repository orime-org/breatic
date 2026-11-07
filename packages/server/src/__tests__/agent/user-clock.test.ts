// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The note that tells the model when, on the user's own clock, a message
 * was sent. Every expected line is written out in full, so a change an ICU
 * release makes to the text the model reads fails here.
 */
import { describe, expect, it } from "vitest";

import { userClockNote } from "@server/agent/user-clock.js";

const AT = new Date("2026-10-01T09:27:00Z");

describe("userClockNote", () => {
  it("gives the user's local date, weekday, time and zone", () => {
    expect(userClockNote(AT, "Asia/Shanghai")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-10-01 17:27 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("follows daylight saving on either side of the change", () => {
    expect(userClockNote(new Date("2026-03-07T17:00:00Z"), "America/New_York")).toBe(
      "[The user's local time when they sent this message: Saturday, 2026-03-07 12:00 (America/New_York, GMT-05:00).]",
    );
    expect(userClockNote(new Date("2026-03-09T17:00:00Z"), "America/New_York")).toBe(
      "[The user's local time when they sent this message: Monday, 2026-03-09 13:00 (America/New_York, GMT-04:00).]",
    );
  });

  it("writes a zero offset with its hours and minutes", () => {
    expect(userClockNote(AT, "UTC")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-10-01 09:27 (UTC, GMT+00:00).]",
    );
    expect(userClockNote(new Date("2026-01-15T00:05:00Z"), "Europe/London")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-01-15 00:05 (Europe/London, GMT+00:00).]",
    );
  });

  it("writes an offset that is not a whole hour", () => {
    expect(userClockNote(AT, "Asia/Kolkata")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-10-01 14:57 (Asia/Kolkata, GMT+05:30).]",
    );
    expect(userClockNote(AT, "America/St_Johns")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-10-01 06:57 (America/St_Johns, GMT-02:30).]",
    );
  });

  it("keeps the offset whole late in a minute", () => {
    expect(userClockNote(new Date("2026-10-01T09:27:59.900Z"), "Asia/Shanghai")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-10-01 17:27 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("moves to the next day when the user's clock already has", () => {
    expect(userClockNote(new Date("2026-10-01T16:30:00Z"), "Asia/Shanghai")).toBe(
      "[The user's local time when they sent this message: Friday, 2026-10-02 00:30 (Asia/Shanghai, GMT+08:00).]",
    );
  });

  it("writes the zone as the browser reported it", () => {
    expect(userClockNote(AT, "Asia/Calcutta")).toBe(
      "[The user's local time when they sent this message: Thursday, 2026-10-01 14:57 (Asia/Calcutta, GMT+05:30).]",
    );
  });

  it("falls back to UTC and says so when no zone came with the message", () => {
    expect(userClockNote(AT, undefined)).toBe(
      "[The time when the user sent this message: Thursday, 2026-10-01 09:27 UTC. Their time zone is unknown.]",
    );
  });

  it("falls back to UTC and says so when the zone is not one Intl knows", () => {
    expect(userClockNote(AT, "Mars/Olympus")).toBe(
      "[The time when the user sent this message: Thursday, 2026-10-01 09:27 UTC. Their time zone is unknown.]",
    );
  });
});
