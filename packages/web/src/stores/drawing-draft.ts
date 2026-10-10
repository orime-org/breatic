// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the reader has drawn on the node for a mask or sketch tool
 * (inner#1302 §6.1). Coordinates are fractions of the source picture, so the
 * same steps paint the screen at any size and the export at the source's
 * own pixels.
 */

/** The shape a press on the node draws. */
export type DrawTool = 'brush' | 'rect' | 'ellipse' | 'eraser';

/** The palette tokens a mask can be shown in; read by a mask only, never sent. */
export const MASK_DISPLAY_COLORS = ['pink', 'red', 'green', 'blue'] as const;

/** One of {@link MASK_DISPLAY_COLORS}. */
export type MaskDisplayColor = (typeof MASK_DISPLAY_COLORS)[number];

/** The sketch tool's inks, painted into the picture the model is sent. */
export const INK = [
  '#FF3B30', // design-value: allow — image content, not a theme token
  '#FFCC00', // design-value: allow — image content, not a theme token
  '#34C759', // design-value: allow — image content, not a theme token
  '#0A84FF', // design-value: allow — image content, not a theme token
  '#FFFFFF', // design-value: allow — image content, not a theme token
  '#000000', // design-value: allow — image content, not a theme token
] as const;

/** The brush diameter's range, in percent of the source's shorter side. */
export const BRUSH_SIZE = { min: 1, max: 25, step: 1, initial: 5 } as const;

/** One drawn op. */
export type DrawOp =
  | {
      readonly kind: 'stroke';
      readonly erase: boolean;
      readonly size: number;
      readonly color: string;
      readonly points: readonly (readonly [number, number])[];
    }
  | {
      readonly kind: 'rect' | 'ellipse';
      readonly size: number;
      readonly color: string;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    };

/** One drawn op, or a Clear that wipes everything drawn before it. */
export type DrawStep = DrawOp | { readonly kind: 'clear' };

/** The drawing held in a mini-tool draft. */
export interface DrawingDraft {
  readonly tool: DrawTool;
  readonly size: number;
  readonly color: string;
  readonly maskColor: MaskDisplayColor;
  /** Every step taken, oldest first. */
  readonly steps: readonly DrawStep[];
  /** Steps taken back by undo, newest last; emptied by any new step. */
  readonly undone: readonly DrawStep[];
}

/** A drawing nobody has touched yet. */
export const EMPTY_DRAWING: DrawingDraft = Object.freeze({
  tool: 'brush',
  size: BRUSH_SIZE.initial,
  color: INK[0],
  maskColor: 'pink',
  steps: [],
  undone: [],
});

/**
 * The ops that show: the steps after the last clear.
 * @param steps - Every step taken.
 * @returns The ops drawn since the last clear.
 */
export function visibleOps(steps: readonly DrawStep[]): DrawOp[] {
  let from = 0;
  steps.forEach((step, index) => {
    if (step.kind === 'clear') from = index + 1;
  });
  return steps.slice(from).filter((step): step is DrawOp => step.kind !== 'clear');
}

/**
 * The drawing with one more step; anything undone can no longer be redone.
 * @param drawing - The drawing.
 * @param step - The step taken.
 * @returns The new drawing.
 */
export function withStep(drawing: DrawingDraft, step: DrawStep): DrawingDraft {
  return { ...drawing, steps: [...drawing.steps, step], undone: [] };
}

/**
 * The drawing with its last step taken back.
 * @param drawing - The drawing.
 * @returns The new drawing, or the same one when there is nothing to undo.
 */
export function undone(drawing: DrawingDraft): DrawingDraft {
  const last = drawing.steps.at(-1);
  if (last === undefined) return drawing;
  return { ...drawing, steps: drawing.steps.slice(0, -1), undone: [...drawing.undone, last] };
}

/**
 * The drawing with its last undone step put back.
 * @param drawing - The drawing.
 * @returns The new drawing, or the same one when there is nothing to redo.
 */
export function redone(drawing: DrawingDraft): DrawingDraft {
  const last = drawing.undone.at(-1);
  if (last === undefined) return drawing;
  return { ...drawing, steps: [...drawing.steps, last], undone: drawing.undone.slice(0, -1) };
}
