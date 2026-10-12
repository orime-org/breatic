// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The number a running task's row counts (#186 §7.3): how long it has run.
 *
 * It is derived from the instant the server opened the task, so a reader's
 * clock only changes how accurate the number looks, never what anything is
 * judged to be. Whether a task ran out of time is settled server-side when
 * somebody reads this node's task list (§4.6).
 *
 * Writing it out is `formatDuration`'s job, in `lib/duration`: the media
 * player puts the same kind of number on the same screen, so the two read it
 * out the same way.
 */

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
