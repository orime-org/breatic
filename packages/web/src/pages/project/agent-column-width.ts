// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The four sizes that decide how wide the Agent column may be, and the pure
 * arithmetic built on them. No DOM, no storage — the hook owns those.
 *
 * Width is TWO independent facts, not one. The panel library holds a single
 * layout and overwrites it with whatever the constraints allowed, so a column
 * squeezed by a narrow window loses the width the user set and never gets it
 * back (measured: set 640, narrow to 900, widen again, and it stops at 579).
 * We therefore keep the user's set width ourselves and derive the rendered
 * width from it, which is what `resolveWidth` does.
 */

/** Narrowest the Agent column may render — the width it had before it could be dragged. */
export const AGENT_COLUMN_MIN_WIDTH = 320;

/** Widest the Agent column may render (user 2026-08-28). */
export const AGENT_COLUMN_MAX_WIDTH = 640;

/**
 * Narrowest the space region may render. Measured on the real app rather than
 * taken from a standard: the canvas toolbar is 317px and does not shrink, and
 * at 320 its undo control was clipped by 13px.
 */
export const SPACE_MIN_WIDTH = 420;

/** The drag handle between the two columns. */
export const RESIZE_HANDLE_WIDTH = 1;

/**
 * Narrowest the project page may lay out. Below this the page scrolls
 * horizontally instead of squeezing either side past its minimum. Constant:
 * collapsing the Agent column does not lower it, so the horizontal scrollbar
 * never blinks in and out as the column is toggled.
 */
export const PAGE_MIN_WIDTH = AGENT_COLUMN_MIN_WIDTH + RESIZE_HANDLE_WIDTH + SPACE_MIN_WIDTH;

/** Half a device pixel either way is not a change worth acting on. */
const RESTORE_TOLERANCE = 1;

/**
 * Clamps a value into an inclusive range.
 * @param value - The value to clamp.
 * @param low - Lower bound.
 * @param high - Upper bound.
 * @returns The value moved into `[low, high]`.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Works out how wide the Agent column should render right now.
 *
 * Shrinking and growing are the same formula: the space region yields down to
 * its 420 first, then the Agent column yields down to its 320; on the way back
 * the Agent column returns to the width the user set before the remainder goes
 * to space.
 * @param setWidth - The width the user dragged to, or null if they never have.
 * @param panelsWidth - How much width the two columns have to divide between
 *   them. This EXCLUDES the drag handle: the library sums the panels'
 *   `offsetWidth` and the handle is not one of them, so a page sitting at
 *   `PAGE_MIN_WIDTH` gives the panels `PAGE_MIN_WIDTH - RESIZE_HANDLE_WIDTH`.
 * @returns A width inside `[320, 640]` that leaves the space region at least 420.
 */
export function resolveWidth(setWidth: number | null, panelsWidth: number): number {
  // A stored value that survived the read gate can still be non-finite here if
  // a caller hands one over; Math.min(NaN, x) is NaN and clamp passes NaN
  // straight through, so the entrance is the only place that can stop it.
  const wanted =
    setWidth !== null && Number.isFinite(setWidth) ? setWidth : AGENT_COLUMN_MIN_WIDTH;
  return clamp(
    Math.min(wanted, panelsWidth - SPACE_MIN_WIDTH),
    AGENT_COLUMN_MIN_WIDTH,
    AGENT_COLUMN_MAX_WIDTH,
  );
}

/**
 * Whether a column that currently renders at `current` should be resized back
 * to `target`.
 *
 * This is the stop condition of a loop: resizing back reports a new layout,
 * which asks the question again. Fractional container widths, browser zoom and
 * HiDPI all make the reported size non-integral, so the tolerance is permanent
 * rather than a rounding patch.
 * @param current - The width the column renders at now.
 * @param target - The width it should render at.
 * @returns True when the gap is worth acting on.
 */
export function shouldRestore(current: number, target: number): boolean {
  return Math.abs(current - target) > RESTORE_TOLERANCE;
}

/**
 * Reads a persisted width back, rejecting anything that is not a positive
 * finite number. `Number` is used rather than `parseFloat` so that trailing
 * junk ("640abc") is rejected instead of silently truncated.
 *
 * The 320..640 range is NOT applied here — `resolveWidth` is the single place
 * that decides it, and it needs the container width to do so.
 * @param raw - The raw string from storage, or null when the key is absent.
 * @returns The stored width, or null when nothing usable is stored.
 */
export function parseStoredWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
