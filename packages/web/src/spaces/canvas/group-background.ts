// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The group background palette — a purely human-chosen classification tint, no
 * system semantics. Four status colors (their 14%-opacity `-bg` tokens) plus
 * 无色 (no tint → neutral dashed frame). The identity color
 * `--color-status-selected` is deliberately excluded: it owns the
 * selected / active meaning and stays reserved for the node selection ring.
 */

/** One choice in the group background picker. */
export interface GroupBackgroundOption {
  /** Stable short id (react key / testid), independent of the token name. */
  key: string;
  /** Stored design token name, or `undefined` for 无色 (clears the tint). */
  value: string | undefined;
  /** i18n key for the option's accessible label. */
  labelKey: string;
}

/** 无色 + the 4 status tints, in picker order. */
export const GROUP_BACKGROUND_OPTIONS: ReadonlyArray<GroupBackgroundOption> = [
  { key: 'none', value: undefined, labelKey: 'canvas.group.backgroundNone' },
  {
    key: 'info',
    value: '--color-status-info-bg',
    labelKey: 'canvas.group.backgroundInfo',
  },
  {
    key: 'success',
    value: '--color-status-success-bg',
    labelKey: 'canvas.group.backgroundSuccess',
  },
  {
    key: 'warning',
    value: '--color-status-warning-bg',
    labelKey: 'canvas.group.backgroundWarning',
  },
  {
    key: 'error',
    value: '--color-status-error-bg',
    labelKey: 'canvas.group.backgroundError',
  },
];

/**
 * The CSS `background-color` for a stored group token. The token name is
 * stored (a stable semantic id); the render layer applies `var()`. 无色
 * (no stored token) maps to `undefined` so the container shows no fill.
 * @param value - The stored token name, or `undefined` for 无色.
 * @returns The `var(...)` color string, or `undefined` when untinted.
 */
export function groupBackgroundStyle(
  value: string | undefined,
): string | undefined {
  return value ? `var(${value})` : undefined;
}
