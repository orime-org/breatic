// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The expand tool's draft (inner#1303 §6.3): the frame around the source and
 * the ratio it is held to. The geometry that moves them is in the canvas's
 * `expand-frame`.
 */

/** The frame, as shares of the source. */
export interface ExpandFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The ratios the frame can be held to: Free and seven fixed ones. */
export const EXPAND_RATIOS = ['free', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] as const;

/** One of {@link EXPAND_RATIOS}. */
export type ExpandRatio = (typeof EXPAND_RATIOS)[number];

/** The frame that is the source itself. */
export const UNIT_FRAME: Readonly<ExpandFrame> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/** The expand tool's draft. */
export interface ExpandDraft {
  readonly frame: ExpandFrame;
  readonly ratio: ExpandRatio;
  /** The longest side the pinned model takes, in source pixels; null until the catalog is read. */
  readonly cap: number | null;
}

/** The draft an expand tool opens with, and goes back to when its source changes. */
export const EMPTY_EXPAND: Readonly<ExpandDraft> = Object.freeze({ frame: UNIT_FRAME, ratio: 'free', cap: null });
