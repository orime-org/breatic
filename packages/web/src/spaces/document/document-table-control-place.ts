// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a table's own controls go (inner#1126 A6, A11): the cell button on the
 * hovered cell, the column handle on the hovered column.
 *
 * Both are smaller than 24px, so WCAG 2.2 SC 2.5.8 asks that a 24px circle
 * centred on each stay clear of the other. On a first-row cell they share a
 * strip along the table's top line; the handle steps aside for the button,
 * and is left out when the part of the cell in view cannot hold both apart.
 * The button's box is worked out here for both of them, so the two never
 * disagree about where it is.
 */

import { COLUMN_RESIZE_ZONE } from '@web/spaces/document/document-table-nodes';

/** A box in viewport coordinates. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The cell button's side, and its inset from the corner it sits in: from the
 * top line, and from the right line clear of that line's column-resize zone,
 * since the button comes up on whatever cell the pointer is over.
 */
const BUTTON = 20;
const INSET = 2;
const RIGHT_INSET = COLUMN_RESIZE_ZONE + 1;

/** The column handle's width and height (`w-6`, `h-3`). */
export const COLUMN_HANDLE_WIDTH = 24;
export const COLUMN_HANDLE_HEIGHT = 12;

/** How thick either handle is across its line: the row handle's width, the column handle's height. */
export const HANDLE_THICKNESS = COLUMN_HANDLE_HEIGHT;

/** The diameter SC 2.5.8 keeps clear around a target under 24px. */
const CLEARANCE = 24;

/**
 * The cell button's box on the part of its cell in view.
 * @param visible - The part of the cell in view.
 * @returns The box, or null when that part has no room for the button.
 */
export function cellButtonBox(visible: Box): Box | null {
  if (visible.right - visible.left < BUTTON + INSET + RIGHT_INSET || visible.bottom - visible.top < BUTTON + 2 * INSET) {
    return null;
  }
  const right = visible.right - RIGHT_INSET;
  const top = visible.top + INSET;
  return { left: right - BUTTON, top, right, bottom: top + BUTTON };
}

/**
 * How far a point is from a box.
 * @param x - The point's x.
 * @param y - The point's y.
 * @param box - The box.
 * @returns The distance, zero inside it.
 */
function toBox(x: number, y: number, box: Box): number {
  return Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
}

/**
 * Whether two targets under 24px keep the clearance SC 2.5.8 asks for: the
 * circle around each clears the other's box and the other's circle.
 * @param a - One target.
 * @param b - The other.
 * @returns Whether they do.
 */
function clear(a: Box, b: Box): boolean {
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const bx = (b.left + b.right) / 2;
  const by = (b.top + b.bottom) / 2;
  const radius = CLEARANCE / 2;
  return toBox(ax, ay, b) >= radius && toBox(bx, by, a) >= radius && Math.hypot(ax - bx, ay - by) >= CLEARANCE;
}

/**
 * Where the column handle's centre goes across.
 * @param visible - The part of the hovered cell in view.
 * @param lineY - The table's top line, which the handle is centred on.
 * @param button - The cell button's box, when one is shown.
 * @returns The centre's x, or null when the handle is left out.
 */
export function columnHandleCentre(visible: Box, lineY: number, button: Box | null): number | null {
  const half = COLUMN_HANDLE_WIDTH / 2;
  const lo = visible.left + half;
  const hi = visible.right - half;
  if (hi < lo) return null;
  const ideal = (visible.left + visible.right) / 2;
  if (button === null) return ideal;
  /**
   * Whether a centre keeps the handle clear of the button.
   * @param x - The centre.
   * @returns Whether it does.
   */
  const fits = (x: number): boolean =>
    clear({ left: x - half, top: lineY - COLUMN_HANDLE_HEIGHT / 2, right: x + half, bottom: lineY + COLUMN_HANDLE_HEIGHT / 2 }, button);
  // The nearest centre to the middle that clears the button, a pixel at a time.
  for (let step = 0; step <= hi - lo; step += 1) {
    for (const x of [ideal - step, ideal + step]) {
      if (x >= lo && x <= hi && fits(x)) return x;
    }
  }
  return null;
}
