// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** A scroll position, or the largest one, of the timeline's track viewport. */
export interface TrackScroll {
  left: number;
  top: number;
}

/**
 * Whether one axis moved because the user scrolled it: a change under 1px is
 * noise, and landing on the new end from beyond it is the browser clamping a
 * shorter track, not the user.
 * @param prev - The last accepted position on this axis.
 * @param next - The position now.
 * @param max - The largest position now.
 * @returns True when the user moved this axis.
 */
function userMovedAxis(prev: number, next: number, max: number): boolean {
  if (Math.abs(next - prev) < 1) return false;
  return !(Math.abs(next - max) < 1 && prev > max);
}

/**
 * Whether a scroll of the track viewport was the user's, which stops
 * following (#920); a clamp after the content shrank is not.
 * @param prev - The last accepted position.
 * @param next - The position now.
 * @param max - The largest position now on each axis.
 * @returns True when the user moved either axis.
 */
export function userMovedScroll(prev: TrackScroll, next: TrackScroll, max: TrackScroll): boolean {
  return userMovedAxis(prev.left, next.left, max.left) || userMovedAxis(prev.top, next.top, max.top);
}
