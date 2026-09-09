// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two numbers a running task's row counts (#186 §7.3).
 *
 * Both are derived from what the server decided — the instant the task opened
 * and the allowance it was given — so a reader's clock only changes how
 * accurate the number looks, never what anything is judged to be. Whether a
 * task ran out of time is settled server-side when somebody reads this node's
 * task list (§4.6); a row may read zero left for a while before that happens.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** A duration broken into the units a row reads out. */
export interface DurationParts {
  /** Hours, the top unit — a long allowance reads as 30 hours, not 1 day. */
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Break a duration into hours, minutes and whole seconds.
 *
 * Anything at or below zero reads as all zeros: a row can outlive its
 * allowance before anyone opens the list that harvests it, and counting
 * backwards there would say something nobody decided.
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
 * How much of a task's allowance is left.
 * @param startedAt - When the server opened it, ISO 8601.
 * @param budgetMs - The allowance the server gave it.
 * @param now - Reader's clock (epoch ms), injectable for tests.
 * @returns Milliseconds left, floored at zero; zero for an unreadable instant.
 */
export function remainingMs(
  startedAt: string,
  budgetMs: number,
  now: number = Date.now(),
): number {
  const opened = Date.parse(startedAt);
  if (Number.isNaN(opened)) return 0;
  return Math.max(0, opened + budgetMs - now);
}

/**
 * How long a task has been running.
 * @param startedAt - When the server opened it, ISO 8601.
 * @param now - Reader's clock (epoch ms), injectable for tests.
 * @returns Milliseconds since it opened, floored at zero.
 */
export function elapsedMs(
  startedAt: string,
  now: number = Date.now(),
): number {
  const opened = Date.parse(startedAt);
  if (Number.isNaN(opened)) return 0;
  return Math.max(0, now - opened);
}
