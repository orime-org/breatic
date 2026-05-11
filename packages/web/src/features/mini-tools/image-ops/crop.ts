/**
 * `crop` mini-tool — frontend (Category A) rectangular crop.
 *
 * Spec: `breatic-inner/design/project/02-2026-05-09-mini-tool-system.md`
 * §2.1 — interactive rect on the source image, Apply commits a PNG of
 * the selected sub-region.
 *
 * The rect arrives normalized in `[0, 1]` so it survives image-size
 * mismatches (the overlay sees the displayed pixel dimensions; the
 * source blob may be a 4K original behind an HTML scaled-down view).
 * `CropOverlay` (mounted on the source image node) writes the rect to
 * `MiniToolContext.specialValues` and BottomToolbar's Apply forwards
 * it through `runCategoryAOp('crop', blob, rect)`.
 *
 * Algorithm: trivial `drawImage` blit with the source rect — canvas
 * does the actual pixel sampling, so quality matches the browser's
 * native downscale (nearest-ish on Safari, bilinear elsewhere; fine
 * for crop since no interpolation is needed except at sub-pixel rects).
 */

/**
 * Normalized crop rectangle. All four fields are in `[0, 1]` relative
 * to the source image's natural dimensions. `width` / `height` are
 * non-zero (Apply blocks zero-area rects upstream).
 */
export interface CropParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Hard lower bound for the resulting blob — guards against accidentally cropping to a single pixel. */
const MIN_DIM_PX = 2;

/** Clamp a value into `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Apply crop to `source` and return a PNG blob.
 *
 * @param source - Source image blob (loaded from the node's `content` URL).
 * @param params - Normalized rect `{x, y, width, height}` in `[0, 1]`.
 * @returns A new PNG blob whose dimensions match the cropped pixel
 *   region of the source.
 * @throws If the image fails to decode, the canvas 2D context isn't
 *   available, or the rect would produce a region smaller than
 *   {@link MIN_DIM_PX} on either axis.
 */
export async function applyCrop(source: Blob, params: CropParams): Promise<Blob> {
  const img = await decodeImage(source);
  const { sx, sy, sw, sh } = resolveSourceRect(img.naturalWidth, img.naturalHeight, params);

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToBlob(canvas);
}

/**
 * Resolve a normalized `[0, 1]` rect against a source image's natural
 * pixel dimensions, clamping out-of-range values and refusing crops
 * smaller than {@link MIN_DIM_PX} on either axis.
 *
 * Exported so the test suite can verify the clamp + minimum-size math
 * without spinning up a canvas.
 *
 * @throws If the resolved rect would be narrower or shorter than
 *   {@link MIN_DIM_PX} pixels — typically a UI bug (the overlay should
 *   clamp drag handles to a minimum), but worth a loud failure rather
 *   than silently producing a 1×1 PNG.
 */
export function resolveSourceRect(
  imgWidth: number,
  imgHeight: number,
  params: CropParams,
): { sx: number; sy: number; sw: number; sh: number } {
  const x = clamp(params.x, 0, 1);
  const y = clamp(params.y, 0, 1);
  const w = clamp(params.width, 0, 1 - x);
  const h = clamp(params.height, 0, 1 - y);

  const sx = Math.round(x * imgWidth);
  const sy = Math.round(y * imgHeight);
  const sw = Math.round(w * imgWidth);
  const sh = Math.round(h * imgHeight);

  if (sw < MIN_DIM_PX || sh < MIN_DIM_PX) {
    throw new Error(
      `Crop rect too small: ${sw}×${sh}px (minimum ${MIN_DIM_PX}×${MIN_DIM_PX})`,
    );
  }

  return { sx, sy, sw, sh };
}

/** Decode a blob into an `HTMLImageElement` ready to draw. */
function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode source image'));
    };
    img.src = url;
  });
}

/** Promise wrapper around `canvas.toBlob`. */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob returned null'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}
