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
type ClockPart = "weekday" | "year" | "month" | "day" | "hour" | "minute";

/**
 * Read a moment in one zone, part by part.
 * @param now - The moment.
 * @param timeZone - A zone `Intl` knows.
 * @returns Each part of the moment on that zone's clock.
 * @throws {RangeError} When timeZone is not a zone Intl knows.
 */
function readClock(now: Date, timeZone: string): Record<ClockPart, string> {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    format.formatToParts(now).map((part) => [part.type, part.value]),
  ) as Record<ClockPart, string>;
}

/**
 * The zone's offset from UTC at that moment, as `GMT+HH:MM`. Worked out from
 * the clock rather than read from `Intl`, whose wording of it differs across
 * ICU releases (Node 22 writes `GMT+00:00` where Node 24 writes `GMT`).
 * @param now - The moment.
 * @param p - The parts of that moment on the zone's clock.
 * @returns The offset, signed, with hours and minutes.
 */
function offsetOf(now: Date, p: Record<ClockPart, string>): string {
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  // The parts stop at the minute, so the moment is cut to its minute as well.
  const minutes = (wall - Math.floor(now.getTime() / 60_000) * 60_000) / 60_000;
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `GMT${sign}${hh}:${mm}`;
}

/**
 * Say when a message was sent, in the reader's zone when we know it.
 * @param now - When the message was sent.
 * @param timeZone - The zone the reader's browser reported, if any.
 * @returns One bracketed line for the model.
 */
export function readerClockNote(now: Date, timeZone: string | undefined): string {
  const known = timeZone !== undefined && isKnownTimeZone(timeZone);
  const p = readClock(now, known ? timeZone : "UTC");
  const when = `${p.weekday}, ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  return known
    ? `[The reader's local time when they sent this message: ${when} (${timeZone}, ${offsetOf(now, p)}).]`
    : `[The time when the reader sent this message: ${when} UTC. Their time zone is unknown.]`;
}
