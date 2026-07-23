// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The single gate for rendering a credit cost. Returns the value unchanged when
 * it is a finite number (including 0 and fractional values — video models bill
 * fractional credits), or undefined when it is absent / non-finite so the UI
 * never shows `NaN` / `undefined`.
 *
 * One source of truth shared by every credits display so they can never diverge
 * (spec §6.4): the node-history row (`entryCredits`) and the activity-feed row
 * both gate through this. Deliberately NO `> 0` gate and NO rounding — a `> 0`
 * gate would hide a genuine free (0-credit) run and rounding would contradict
 * the raw billed value (0.4 → "0"). The DATA source differs per caller (node
 * history reads the estimate `metadata.cost`; the activity feed reads the actual
 * deducted `payload.credits`), only the gate + raw-value rule are shared.
 * @param value - A candidate credit cost (number, null, undefined, or anything).
 * @returns The finite number, or undefined.
 */
export function formatCredits(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
