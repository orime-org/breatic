/**
 * Image crop handler — first Sharp-based (Node-library) local handler.
 *
 * Contrast with `handlers/local/video/crop.ts`: that one spawns an
 * external `ffmpeg` process and juggles temp files. This handler runs
 * entirely inside the Node process via Sharp (libvips under the hood)
 * — no child process, no intermediate file when possible. Same
 * `runLocalHandler` framework, same registry surface; the handler
 * picks its own library. That's the library-agnostic claim made good
 * in phase 1's scaffold.
 *
 * Params contract:
 *
 *   image: string       — http(s) URL to an image in permanent storage
 *   x, y, w, h: number      — crop rectangle in source pixels
 *                             (top-left x/y, width/height)
 *
 * Output format: PNG (preserves transparency from source if present;
 * Sharp's default encoder for Buffer output is 8-bit RGBA PNG for
 * images that had alpha, RGB PNG otherwise).
 *
 * Rejected at validation:
 *   - non-http(s) URLs (dataURL / blob / file paths not supported;
 *     project convention is OSS/S3/local-HTTP)
 *   - non-finite or non-positive rect dimensions
 *   - rect extending past source bounds (Sharp would throw anyway,
 *     we fail early with a clear message)
 */

import sharp from "sharp";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { uploadBufferToStorage } from "../runtime/upload.js";

interface CropParams {
  image: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseParams(raw: Record<string, unknown>): CropParams {
  const image = raw.image;
  const x = raw.x;
  const y = raw.y;
  const w = raw.w;
  const h = raw.h;

  if (typeof image !== "string" || !/^https?:\/\//i.test(image)) {
    throw new Error("image/crop: `image` must be an http(s) URL");
  }
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") {
    throw new Error("image/crop: `x`, `y`, `w`, `h` must be numbers");
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error("image/crop: crop rect values must be finite");
  }
  if (w <= 0 || h <= 0) {
    throw new Error("image/crop: `w` and `h` must be positive");
  }
  return { image, x, y, w, h };
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { image, x, y, w, h } = parseParams(rawParams);

  // Fetch source → Buffer in memory. Sharp streams from Buffer too, no
  // tempfile needed. A 20 MB 8K image decodes to ~200 MB of raw pixels
  // inside Sharp's pipeline; libvips streams line-by-line under the
  // hood so peak RSS stays far below that.
  const response = await fetch(image);
  if (!response.ok) {
    throw new Error(`image/crop: download failed (HTTP ${response.status}) for ${image}`);
  }
  const sourceBuffer = Buffer.from(await response.arrayBuffer());

  // Validate crop rect against source dimensions before extract (Sharp
  // throws a less-helpful "extract_area: bad extract area" otherwise).
  const metadata = await sharp(sourceBuffer).metadata();
  const srcW = metadata.width ?? 0;
  const srcH = metadata.height ?? 0;
  if (srcW === 0 || srcH === 0) {
    throw new Error("image/crop: source has no detectable dimensions");
  }

  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const width = Math.max(1, Math.floor(w));
  const height = Math.max(1, Math.floor(h));
  if (left + width > srcW || top + height > srcH) {
    throw new Error(
      `image/crop: rect (${left},${top},${width}x${height}) ` +
        `exceeds source size ${srcW}x${srcH}`,
    );
  }

  // Sharp pipeline: decode → extract → encode PNG.
  const outputBuffer = await sharp(sourceBuffer)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();

  const url = await uploadBufferToStorage({
    buffer: outputBuffer,
    userId: ctx.userId,
    projectId: ctx.projectId,
    taskType: ctx.taskType,
    ext: ".png",
    contentType: "image/png",
  });

  return { url, cost: 0 };
};

export default handler;
