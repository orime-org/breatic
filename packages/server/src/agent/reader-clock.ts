// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The note that tells the model when, on the reader's own clock, a message
 * was sent.
 *
 * The model has no clock of its own, and the server runs on UTC, so the
 * reader's zone comes from their browser with each message. The note opens
 * that turn's user message only; see `MainAgent.runTurn` for why it stays out of
 * the system prompt and the stored history.
 */

import { isKnownTimeZone } from "@server/utils/time-zone.js";

/** The parts of a moment the note is built from, as `Intl` names them. */
type ClockPart = "weekday" | "year" | "month" | "day" | "hour" | "minute" | "timeZoneName";

/**
 * Read a moment in one zone, part by part.
 * @param now - The moment.
 * @param timeZone - A zone `Intl` knows.
 * @returns Each part of the moment in that zone, and the zone's resolved name.
 * @throws {RangeError} When timeZone is not a zone Intl knows.
 */
function readClock(now: Date, timeZone: string): { parts: Record<ClockPart, string>; zone: string } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    // `GMT+08:00`, and plain `GMT` at a zero offset.
    timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(
    format.formatToParts(now).map((part) => [part.type, part.value]),
  ) as Record<ClockPart, string>;
  return { parts, zone: format.resolvedOptions().timeZone };
}

/**
 * Say when a message was sent, in the reader's zone when we know it.
 * @param now - When the message was sent.
 * @param timeZone - The zone the reader's browser reported, if any.
 * @returns One bracketed line for the model.
 */
export function readerClockNote(now: Date, timeZone: string | undefined): string {
  const known = timeZone !== undefined && isKnownTimeZone(timeZone);
  const { parts: p, zone } = readClock(now, known ? timeZone : "UTC");
  const when = `${p.weekday}, ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  return known
    ? `[The reader's local time when they sent this message: ${when} (${zone}, ${p.timeZoneName}).]`
    : `[The time when the reader sent this message: ${when} UTC. Their time zone is unknown.]`;
}
