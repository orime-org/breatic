// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Timing constants for the unified {@link HoverPreview} (#1622). Kept in one
 * module so every hover surface (activity feed, node history #1814, generate
 * chip #1815) shares the same calibrated feel and it can never drift.
 *
 * `HOVER_OPEN_DELAY_MS` matches the app-level `TooltipProvider delayDuration`
 * (`App.tsx`, 100ms) — the whole app was tuned to this value after a 300ms
 * tooltip drew a "too slow" report (#337). HoverCard has no shared provider, so
 * the delay is set per instance from this constant instead of inherited.
 */
export const HOVER_OPEN_DELAY_MS = 100;

/**
 * Close grace after the pointer leaves the trigger + card — long enough to let
 * the pointer travel into the card (to click play / drag seek), short enough to
 * not feel sticky. Only `openDelay` was pinned by product; this is the paired
 * close value.
 */
export const HOVER_CLOSE_DELAY_MS = 200;
