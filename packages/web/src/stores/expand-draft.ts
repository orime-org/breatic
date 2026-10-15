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

/** Where the node shows the picture: its offset in the node and its drawn size, in layout pixels. */
export interface ExpandView {
  readonly at: { readonly x: number; readonly y: number };
  readonly box: { readonly width: number; readonly height: number };
  readonly src: string | null;
}

/** The expand tool's draft. */
export interface ExpandDraft {
  readonly frame: ExpandFrame;
  readonly ratio: ExpandRatio;
  /**
   * How far the picture has been moved inside the frame since the frame last
   * wrapped it, as shares of it: the frame keeps its place on the canvas and
   * the picture moves. Held here rather than in the node, which the canvas
   * unmounts while it is off screen.
   */
  readonly shift: { readonly x: number; readonly y: number };
  /**
   * Where the node last showed the picture, which the frame is drawn from: the
   * frame is drawn outside the node, so it stays while the node is off screen
   * and unmounted. Null until the node has measured it.
   */
  readonly view: ExpandView | null;
}

/** The draft an expand tool opens with, and goes back to when its source changes. */
export const EMPTY_EXPAND: Readonly<ExpandDraft> = Object.freeze({
  frame: UNIT_FRAME,
  ratio: 'free',
  shift: Object.freeze({ x: 0, y: 0 }),
  view: null,
});
