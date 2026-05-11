/**
 * `adjust` mini-tool — frontend (Category A) brightness / contrast /
 * saturation manipulation on an image blob.
 *
 * Spec: `breatic-inner/design/project/02-2026-05-09-mini-tool-system.md`
 * §2.2 — each param is a slider in `[-50, 50]` with `0` = identity. Per
 * v13 frontend/backend boundary, this is an instant (<100 ms) op that
 * runs purely in-browser; no Worker dispatch, no credit cost.
 *
 * Pipeline:
 *   1. Decode the source blob into an `HTMLImageElement` (durable
 *      presigned URL from F5; CORS is set up in `assets.ts`).
 *   2. Draw to a same-size 2D canvas.
 *   3. `getImageData` → per-pixel transform → `putImageData`.
 *   4. `canvas.toBlob()` → PNG blob the caller uploads back through
 *      the canonical `useUploadFiles` pipeline.
 *
 * Why not CSS `filter` strings: those render-time effects don't bake
 * into a raster, so the result can't be uploaded as a node `content`.
 * Pixel-loop is honest about "this is a new asset".
 */

/** Slider values from the `adjust` schema; range `[-50, 50]`, `0` = identity. */
export interface AdjustParams {
  brightness: number;
  contrast: number;
  saturation: number;
}

/**
 * Apply brightness / contrast / saturation to `source` and return a PNG blob.
 *
 * @param source - Source image blob (loaded from the node's `content` URL).
 * @param params - User-set slider values.
 * @returns A new PNG blob with the transform baked in. Same pixel dimensions
 *   as the source — `adjust` never resizes.
 * @throws If the image fails to decode or the canvas 2D context isn't
 *   available (e.g. running headless without `OffscreenCanvas`).
 */
export async function applyAdjust(source: Blob, params: AdjustParams): Promise<Blob> {
  const img = await decodeImage(source);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyAdjustInPlace(imgData.data, params);
  ctx.putImageData(imgData, 0, 0);

  const blob = await canvasToBlob(canvas);
  return blob;
}

/**
 * In-place pixel transform. Exported for unit tests so we don't need to
 * spin up a canvas / image-decode roundtrip just to verify the math.
 *
 * @param data - The RGBA byte array from `ImageData.data` (mutated).
 * @param params - Slider values; range `[-50, 50]` per slider.
 */
export function applyAdjustInPlace(data: Uint8ClampedArray, params: AdjustParams): void {
  // Brightness: -50 → -127, +50 → +127, linear.
  const brightness = (params.brightness / 50) * 127;
  // Contrast: -50 → 0.5x, +50 → 2x (multiplicative around 128).
  const contrast = params.contrast >= 0 ? 1 + params.contrast / 50 : 1 + params.contrast / 100;
  // Saturation: -50 → 0 (greyscale), 0 → 1 (no change), +50 → 2 (super-saturated).
  const saturation = 1 + params.saturation / 50;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // Brightness — linear bias before contrast.
    r += brightness;
    g += brightness;
    b += brightness;

    // Contrast — pivot around 128.
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    // Saturation — interpolate between grey (Rec. 601 luma) and full color.
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;
    r = grey + (r - grey) * saturation;
    g = grey + (g - grey) * saturation;
    b = grey + (b - grey) * saturation;

    // Uint8ClampedArray auto-clamps writes to [0, 255]; no manual clamp needed.
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    // Alpha (data[i + 3]) untouched.
  }
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
