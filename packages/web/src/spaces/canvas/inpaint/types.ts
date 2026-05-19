/**
 * Inpaint stroke + mask types — shared across the canvas, controls, and
 * export. Strokes are normalized to image-pixel coordinates so the mask
 * stays correct across zoom levels.
 */

export interface InpaintPoint {
  x: number;
  y: number;
}

export interface InpaintStroke {
  id: string;
  /** Brush radius in image pixels. */
  radius: number;
  /** Stroke alpha [0, 1] — drives mask opacity. */
  alpha: number;
  /** Polyline points in image-pixel coordinates. */
  points: ReadonlyArray<InpaintPoint>;
}
