// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long something ran, written the way the canvas writes it.
 *
 * Three places on the canvas put a duration on screen — the counter on a
 * running task's row, the media player's position and running time, and the
 * focus crop timeline's — and a reader sees them in the same session. One
 * definition, because two would eventually
 * disagree about where the hour goes: the media player's used to say `60:00`
 * for an hour-long video while a task's counter said `1:00:00`.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** A duration broken into the units a reader reads out. */
export interface DurationParts {
  /** Hours, the top unit — a long allowance reads as 30 hours, not 1 day. */
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Break a duration into hours, minutes and whole seconds.
 *
 * Anything at or below zero reads as all zeros: a task row can outlive its
 * allowance before anyone opens the list that harvests it, and counting
 * backwards there would say something nobody decided. A media element reports
 * `NaN` for its duration until it has read the metadata, and that lands here
 * too.
 * @param ms - The duration in milliseconds.
 * @returns The three units, each floored.
 */
export function splitDuration(ms: number): DurationParts {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  return {
    hours: Math.floor(total / HOUR_MS),
    minutes: Math.floor((total % HOUR_MS) / MINUTE_MS),
    seconds: Math.floor((total % MINUTE_MS) / SECOND_MS),
  };
}

/**
 * A duration as a running counter reads it.
 *
 * The seconds are always two digits and the minutes become two once there is
 * an hours field, so a counter ticking once a second keeps its width and the
 * text beside it stays put.
 * @param ms - The duration in milliseconds.
 * @returns `M:SS`, or `H:MM:SS` once there is at least one hour.
 */
export function formatDuration(ms: number): string {
  const { hours, minutes, seconds } = splitDuration(ms);
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

/**
 * The same duration, given in seconds — what a media element reports.
 * @param seconds - The duration in seconds; `NaN` and negatives read as zero.
 * @returns `M:SS`, or `H:MM:SS` once there is at least one hour.
 */
export function formatSeconds(seconds: number): string {
  return formatDuration(seconds * SECOND_MS);
}
