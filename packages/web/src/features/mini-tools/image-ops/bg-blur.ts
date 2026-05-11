/**
 * `bg-blur` mini-tool — frontend (Category A) gaussian-ish blur on an
 * image blob.
 *
 * Spec: `breatic-inner/design/project/02-2026-05-09-mini-tool-system.md`
 * §2.2 — `radius` slider `[0, 100]` + `preserveSubject` toggle. The
 * spec marks this tool as `Demo`, meaning the "preserve subject"
 * semantics require an actual segmentation model that V1 doesn't ship.
 * **In V1 the toggle is honored as a no-op** — the value is persisted
 * onto the sibling node's `operationParams` so a future bg-blur pass
 * can detect a v1-era sibling and re-blur with real subject masking,
 * but the V1 transform always blurs the whole image. The schema/UI
 * still surfaces the toggle so the user contract is forward-compatible.
 *
 * The `radius` slider's `[0, 100]` UI range maps to pixel kernel
 * half-width `[0, 50]`. Anything past ~30 looks heavy on a typical
 * 1024×* canvas image; 50 is the practical ceiling.
 *
 * Algorithm: separable 3-pass box blur, which approximates a Gaussian
 * blur (proven property — repeated box convolutions converge to a
 * Gaussian). Three boxes give a visually pleasing softness without the
 * cost of a true Gaussian kernel. Using a running-sum implementation
 * keeps the time O(W·H) per pass, independent of radius, so even the
 * heaviest slider stays under our `<100 ms` Category A budget.
 */

/** Slider + toggle values from the `bg-blur` schema. */
export interface BgBlurParams {
  /** `[0, 100]`; `0` = no blur, `100` = heavy blur. */
  radius: number;
  /**
   * V1 dummy — see file header. Persisted but ignored by the
   * transform; reserved for the V2 subject-aware path.
   */
  preserveSubject: boolean;
}

/** Map the schema's 0–100 slider to a pixel kernel half-width. */
function pixelRadius(sliderValue: number): number {
  const clamped = Math.min(100, Math.max(0, sliderValue));
  return Math.round((clamped / 100) * 50);
}

/**
 * Apply background blur to `source` and return a PNG blob.
 *
 * @param source - Source image blob (loaded from the node's `content` URL).
 * @param params - Slider + toggle values.
 * @returns A new PNG blob, same dimensions as the source.
 * @throws If the image fails to decode or the canvas 2D context isn't
 *   available.
 */
export async function applyBgBlur(source: Blob, params: BgBlurParams): Promise<Blob> {
  const img = await decodeImage(source);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyBgBlurInPlace(imgData.data, canvas.width, canvas.height, params);
  ctx.putImageData(imgData, 0, 0);

  return canvasToBlob(canvas);
}

/**
 * In-place 3-pass separable box blur. Exported so the suite can verify
 * blur math against a small handcrafted pixel buffer without spinning
 * up a canvas.
 *
 * @param data - The RGBA byte array from `ImageData.data` (mutated).
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param params - Slider + toggle values; `preserveSubject` is ignored in V1.
 */
export function applyBgBlurInPlace(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  params: BgBlurParams,
): void {
  const r = pixelRadius(params.radius);
  if (r === 0) return;

  // Three passes of a box blur approximate a Gaussian. Even radii
  // hurt the centering math — bump to odd for the last pass.
  const radii = [r, r, r + (r % 2 === 0 ? 1 : 0)];

  // Working float buffers — Uint8ClampedArray rounds + clamps on
  // every write, which destroys multi-pass accuracy. Round to bytes
  // only at the final write.
  let src = new Float32Array(data.length);
  let dst = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) src[i] = data[i];

  for (const radius of radii) {
    boxBlurH(src, dst, width, height, radius);
    [src, dst] = [dst, src];
    boxBlurV(src, dst, width, height, radius);
    [src, dst] = [dst, src];
  }

  for (let i = 0; i < data.length; i++) data[i] = src[i];
}

/**
 * Horizontal box blur via running sum. Reads RGBA from `src` into
 * `dst`; alpha (index `i + 3`) is preserved untouched per-pixel.
 *
 * Boundary handling: clamp — pixels outside `[0, width)` repeat the
 * nearest edge sample. This avoids the dark halo a zero-padded blur
 * leaves on edge pixels.
 */
function boxBlurH(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
): void {
  const window = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 3; c++) {
      // Seed running sum with the leftmost-window pixels (left edge clamped).
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const x = Math.max(0, Math.min(w - 1, i));
        sum += src[row + x * 4 + c];
      }
      for (let x = 0; x < w; x++) {
        dst[row + x * 4 + c] = sum / window;
        const xOut = Math.max(0, Math.min(w - 1, x - r));
        const xIn = Math.max(0, Math.min(w - 1, x + r + 1));
        sum += src[row + xIn * 4 + c] - src[row + xOut * 4 + c];
      }
    }
    // Copy alpha row through verbatim.
    for (let x = 0; x < w; x++) {
      dst[row + x * 4 + 3] = src[row + x * 4 + 3];
    }
  }
}

/** Vertical box blur via running sum. Same boundary clamp as `boxBlurH`. */
function boxBlurV(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
): void {
  const window = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const y = Math.max(0, Math.min(h - 1, i));
        sum += src[(y * w + x) * 4 + c];
      }
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * 4 + c] = sum / window;
        const yOut = Math.max(0, Math.min(h - 1, y - r));
        const yIn = Math.max(0, Math.min(h - 1, y + r + 1));
        sum += src[(yIn * w + x) * 4 + c] - src[(yOut * w + x) * 4 + c];
      }
    }
    // Alpha column passthrough.
    for (let y = 0; y < h; y++) {
      dst[(y * w + x) * 4 + 3] = src[(y * w + x) * 4 + 3];
    }
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
