/**
 * `filter` mini-tool — frontend (Category A) color-grading presets
 * applied to an image blob.
 *
 * Spec: `breatic-inner/design/project/02-2026-05-09-mini-tool-system.md`
 * §2.2 — `preset` enum (`none` / `mono` / `sepia` / `film` / `cool` /
 * `warm`) plus `intensity` slider `[0, 100]`. Intensity linearly blends
 * the source pixel against the preset's full-strength output:
 *   - `intensity: 0`  → source unchanged
 *   - `intensity: 50` → 50/50 mix
 *   - `intensity: 100` → full preset effect
 *
 * Why not CSS `filter`: render-time effects don't bake into a raster,
 * so the result can't be uploaded as a node's `content`. Pixel-loop is
 * honest about "this is a new asset".
 */

/** All preset ids defined in the spec, plus `none` for "no transform". */
export type FilterPreset = 'none' | 'mono' | 'sepia' | 'film' | 'cool' | 'warm';

/** Filter params surfaced by the schema. */
export interface FilterParams {
  preset: FilterPreset;
  /** 0 = source unchanged; 100 = full preset effect; linear blend in between. */
  intensity: number;
}

/**
 * Apply the picked preset to `source` and return a PNG blob.
 *
 * @param source - Source image blob (loaded from the node's `content` URL).
 * @param params - Preset + intensity slider.
 * @returns A new PNG blob, same dimensions as the source.
 * @throws If the image fails to decode or the canvas 2D context isn't
 *   available.
 */
export async function applyFilter(source: Blob, params: FilterParams): Promise<Blob> {
  const img = await decodeImage(source);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyFilterInPlace(imgData.data, params);
  ctx.putImageData(imgData, 0, 0);

  return canvasToBlob(canvas);
}

/**
 * In-place pixel transform. Exported so unit tests can verify the
 * math without spinning up a canvas / image-decode roundtrip.
 *
 * @param data - The RGBA byte array from `ImageData.data` (mutated).
 * @param params - Preset id + intensity in `[0, 100]`.
 */
export function applyFilterInPlace(data: Uint8ClampedArray, params: FilterParams): void {
  if (params.preset === 'none' || params.intensity <= 0) return;
  const t = Math.min(100, Math.max(0, params.intensity)) / 100;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const [tr, tg, tb] = presetTransform(params.preset, r, g, b);
    // Linear blend source ↔ preset output.
    data[i] = r * (1 - t) + tr * t;
    data[i + 1] = g * (1 - t) + tg * t;
    data[i + 2] = b * (1 - t) + tb * t;
    // Alpha (data[i + 3]) untouched.
  }
}

/**
 * Compute one pixel's full-strength preset output. Returned as a tuple
 * of `[r, g, b]` floats; `Uint8ClampedArray` auto-clamps + rounds on
 * write, so the caller does not need to clamp these explicitly.
 */
function presetTransform(
  preset: FilterPreset,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  switch (preset) {
    case 'mono': {
      // Rec. 601 luma — same coefficients we use in adjust's saturation.
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      return [y, y, y];
    }
    case 'sepia': {
      // Classic sepia matrix (Microsoft's reference values).
      return [
        0.393 * r + 0.769 * g + 0.189 * b,
        0.349 * r + 0.686 * g + 0.168 * b,
        0.272 * r + 0.534 * g + 0.131 * b,
      ];
    }
    case 'film': {
      // "Faded film" look: lift shadows ~5%, lower highlights ~5%, warm cast.
      // The 0.9× + 12 lift compresses the dynamic range like cinema does.
      return [r * 0.9 + 14, g * 0.9 + 9, b * 0.9 + 0];
    }
    case 'cool': {
      // Blue shift — pull red down, push blue up.
      return [r - 18, g, b + 18];
    }
    case 'warm': {
      // Orange shift — push red up, green slightly, pull blue down.
      return [r + 20, g + 6, b - 18];
    }
    case 'none':
    default:
      return [r, g, b];
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
