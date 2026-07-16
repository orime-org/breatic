// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Crop-marquee geometry for the focus tool (#1782) — pure functions only.
 *
 * All rects live in DISPLAY pixel space of the node's rendered image (the
 * overlay feeds raw pointer coordinates in); {@link toNaturalCrop} maps the
 * final rect to source-resolution pixels for the actual canvas crop, so
 * the exported image is zoom-independent. Ratios are width/height numbers
 * (`null` = free-form). The overlay component owns NO geometry — every
 * pointer interaction funnels through these functions, which keeps the
 * whole behavior unit-testable without a browser.
 */

/** A crop rectangle in display pixels (always normalized: w/h ≥ 0). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A width/height pair (display bounds or natural image size). */
export interface CropSize {
  width: number;
  height: number;
}

/** The eight resize handles (compass naming). */
export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Minimum crop side length in display pixels — below this a marquee is
 * treated as an accidental click, not a crop (see {@link isCropValid}).
 */
export const MIN_CROP_PX = 8;

/**
 * The ratified ratio presets (user decision E 2026-07-16), in display
 * order. `value` = width / height.
 */
export const CROP_RATIOS: ReadonlyArray<{ key: string; value: number }> = [
  { key: '16:9', value: 16 / 9 },
  { key: '3:2', value: 3 / 2 },
  { key: '4:3', value: 4 / 3 },
  { key: '1:1', value: 1 },
  { key: '3:4', value: 3 / 4 },
  { key: '2:3', value: 2 / 3 },
  { key: '9:16', value: 9 / 16 },
];

/**
 * Clamp a value into `[min, max]`.
 * @param v - The value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The clamped value.
 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Build the marquee rect from the drag anchor to the cursor. Any drag
 * direction normalizes to a positive rect; the cursor is clamped to the
 * bounds. With a ratio, the dominant drag axis drives the size (the other
 * dimension derives from the ratio) and the rect shrinks to fit the
 * available room toward the drag direction while keeping the ratio exact.
 * @param anchor - Where the drag started (display px).
 * @param anchor.x - Anchor x (display px).
 * @param anchor.y - Anchor y (display px).
 * @param cursor - The current pointer position (display px).
 * @param cursor.x - Cursor x (display px).
 * @param cursor.y - Cursor y (display px).
 * @param bounds - The image's display size.
 * @param ratio - Width/height constraint, or null for free-form.
 * @returns The normalized, clamped marquee rect.
 */
export function drawRect(
  anchor: { x: number; y: number },
  cursor: { x: number; y: number },
  bounds: CropSize,
  ratio: number | null,
): CropRect {
  const cx = clamp(cursor.x, 0, bounds.width);
  const cy = clamp(cursor.y, 0, bounds.height);
  if (ratio === null) {
    const x = Math.min(anchor.x, cx);
    const y = Math.min(anchor.y, cy);
    return { x, y, width: Math.abs(cx - anchor.x), height: Math.abs(cy - anchor.y) };
  }
  const dx = cx - anchor.x;
  const dy = cy - anchor.y;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  // Dominant axis drives the size; the other derives from the ratio.
  let width = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
  // Room available from the anchor toward the drag direction, expressed as
  // a max width that still fits BOTH axes at this ratio.
  const roomX = sx > 0 ? bounds.width - anchor.x : anchor.x;
  const roomY = sy > 0 ? bounds.height - anchor.y : anchor.y;
  width = Math.min(width, roomX, roomY * ratio);
  const height = width / ratio;
  return {
    x: sx > 0 ? anchor.x : anchor.x - width,
    y: sy > 0 ? anchor.y : anchor.y - height,
    width,
    height,
  };
}

/**
 * Translate a rect by a delta, clamped so it stays fully inside the bounds.
 * @param rect - The rect to move.
 * @param dx - Horizontal delta (display px).
 * @param dy - Vertical delta (display px).
 * @param bounds - The image's display size.
 * @returns The moved, clamped rect (size unchanged).
 */
export function moveRect(
  rect: CropRect,
  dx: number,
  dy: number,
  bounds: CropSize,
): CropRect {
  return {
    x: clamp(rect.x + dx, 0, bounds.width - rect.width),
    y: clamp(rect.y + dy, 0, bounds.height - rect.height),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Resize a rect by dragging one of its eight handles to the cursor,
 * anchored at the opposite corner / edge. Corner handles behave exactly
 * like {@link drawRect} from the opposite corner (crossing the anchor
 * flips + normalizes). Edge handles move their axis only; with a ratio the
 * other dimension derives around the cross-axis centre, shrunk to fit the
 * bounds while keeping the ratio.
 * @param rect - The rect being resized.
 * @param handle - Which handle is dragged.
 * @param cursor - The current pointer position (display px).
 * @param cursor.x - Cursor x (display px).
 * @param cursor.y - Cursor y (display px).
 * @param bounds - The image's display size.
 * @param ratio - Width/height constraint, or null for free-form.
 * @returns The resized, normalized, clamped rect.
 */
export function resizeRect(
  rect: CropRect,
  handle: CropHandle,
  cursor: { x: number; y: number },
  bounds: CropSize,
  ratio: number | null,
): CropRect {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  if (handle.length === 2) {
    // Corner: the opposite corner is the anchor; reuse the marquee math.
    const anchor = {
      x: handle.includes('w') ? right : left,
      y: handle.includes('n') ? bottom : top,
    };
    return drawRect(anchor, cursor, bounds, ratio);
  }

  // Edge: only that axis follows the cursor.
  const cx = clamp(cursor.x, 0, bounds.width);
  const cy = clamp(cursor.y, 0, bounds.height);
  let next: CropRect;
  if (handle === 'e' || handle === 'w') {
    const anchorX = handle === 'e' ? left : right;
    const x = Math.min(anchorX, cx);
    next = { x, y: top, width: Math.abs(cx - anchorX), height: rect.height };
  } else {
    const anchorY = handle === 's' ? top : bottom;
    const y = Math.min(anchorY, cy);
    next = { x: left, y, width: rect.width, height: Math.abs(cy - anchorY) };
  }
  if (ratio === null) return next;

  // Ratio on an edge handle: derive the cross dimension around its centre,
  // capped by the room toward the DRAG direction so the ratio stays exact.
  // The position is sign-aware relative to the anchor edge — dragging past
  // the anchor flips the rect to the cursor side, exactly like the
  // free-form math above (adversarial 2026-07-16: assuming no flip jumped
  // the rect to the wrong side of the anchor).
  if (handle === 'e' || handle === 'w') {
    const anchorX = handle === 'e' ? left : right;
    const sx = cx >= anchorX ? 1 : -1;
    const roomX = sx > 0 ? bounds.width - anchorX : anchorX;
    const width = Math.min(next.width, roomX, bounds.height * ratio);
    const height = width / ratio;
    const centerY = top + rect.height / 2;
    const y = clamp(centerY - height / 2, 0, bounds.height - height);
    const x = sx > 0 ? anchorX : anchorX - width;
    return { x, y, width, height };
  }
  const anchorY = handle === 's' ? top : bottom;
  const sy = cy >= anchorY ? 1 : -1;
  const roomY = sy > 0 ? bounds.height - anchorY : anchorY;
  const height = Math.min(next.height, roomY, bounds.width / ratio);
  const width = height * ratio;
  const centerX = left + rect.width / 2;
  const x = clamp(centerX - width / 2, 0, bounds.width - width);
  const y = sy > 0 ? anchorY : anchorY - height;
  return { x, y, width, height };
}

/**
 * Re-shape an existing rect to a ratio preset: keep the width and the
 * centre, derive the height; if the result overflows the bounds, shrink
 * proportionally (ratio kept exact) and clamp back inside.
 * @param rect - The current rect.
 * @param ratio - The preset's width/height value.
 * @param bounds - The image's display size.
 * @returns The re-shaped, clamped rect.
 */
export function applyRatioPreset(
  rect: CropRect,
  ratio: number,
  bounds: CropSize,
): CropRect {
  // Seed at least the minimum on BOTH axes (round-4): keeping a thin
  // rect's width could derive a sub-MIN_CROP_PX height, stranding the
  // invisible sliver the degenerate-rect invariant forbids. The bounds
  // shrink below still wins on tiny images (the caller discards an
  // invalid result).
  let width = Math.max(rect.width, MIN_CROP_PX, MIN_CROP_PX * ratio);
  let height = width / ratio;
  // Shrink (keeping the ratio) until both dims fit.
  if (width > bounds.width) {
    width = bounds.width;
    height = width / ratio;
  }
  if (height > bounds.height) {
    height = bounds.height;
    width = height * ratio;
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: clamp(cx - width / 2, 0, bounds.width - width),
    y: clamp(cy - height / 2, 0, bounds.height - height),
    width,
    height,
  };
}

/**
 * Whether a marquee is large enough to confirm as a crop.
 * @param rect - The rect to check.
 * @returns True when both sides are at least {@link MIN_CROP_PX}.
 */
export function isCropValid(rect: CropRect): boolean {
  return rect.width >= MIN_CROP_PX && rect.height >= MIN_CROP_PX;
}

/**
 * Map a display-space rect to source-resolution (natural) pixels for the
 * actual canvas crop: scale, round to integers, then clamp so the rect
 * stays at least 1×1 and never exceeds the natural bounds (rounding at
 * the far edge could otherwise overshoot by a pixel).
 * @param rect - The confirmed marquee in display px.
 * @param display - The image's display size.
 * @param natural - The image's natural (source) size.
 * @returns Integer crop rect in natural pixels.
 */
export function toNaturalCrop(
  rect: CropRect,
  display: CropSize,
  natural: CropSize,
): CropRect {
  const scaleX = natural.width / display.width;
  const scaleY = natural.height / display.height;
  const x = clamp(Math.round(rect.x * scaleX), 0, natural.width - 1);
  const y = clamp(Math.round(rect.y * scaleY), 0, natural.height - 1);
  const width = clamp(Math.round(rect.width * scaleX), 1, natural.width - x);
  const height = clamp(Math.round(rect.height * scaleY), 1, natural.height - y);
  return { x, y, width, height };
}
