/**
 * Video crop handler — first local (non-vendor) mini-tool.
 *
 * Runs FFmpeg's `crop` filter over an OSS video source and uploads
 * the cropped result back to permanent storage. Single-shot pipeline,
 * no intermediate Yjs writes (status is driven entirely by the outer
 * `task-events` stream via `publishNodeEvent`).
 *
 * Params contract:
 *
 *   video: string          — http(s) URL to a video in permanent storage
 *                            (field name matches the rest of the video
 *                            mini-tool family)
 *   x, y, w, h: number     — crop rectangle in source pixels (FFmpeg convention:
 *                            x/y is top-left, w/h is box size)
 *
 * Rounding: FFmpeg `crop` rejects odd widths/heights for many codecs.
 * We clamp each to an even integer via `Math.max(2, Math.floor(v / 2) * 2)`
 * which matches what the pre-migration front-end code did, so behaviour
 * is identical.
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "@worker/handlers/local/index.js";
import { downloadToTempDir } from "@worker/handlers/local/runtime/download.js";
import { uploadTempFileToStorage } from "@worker/handlers/local/runtime/upload.js";
import { spawnCollected } from "@worker/handlers/local/runtime/spawn.js";

interface CropParams {
  video: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Validate and normalise the raw job params into a typed crop payload.
 * @param raw - Raw mini-tool params from the job payload
 * @returns The validated `{ video, x, y, w, h }` crop rectangle
 * @throws {Error} when `video` is not an http(s) URL or the crop rect is invalid
 */
function parseParams(raw: Record<string, unknown>): CropParams {
  const video = raw.video;
  const x = raw.x;
  const y = raw.y;
  const w = raw.w;
  const h = raw.h;

  if (typeof video !== "string" || !/^https?:\/\//.test(video)) {
    throw new Error("video/crop: `video` must be an http(s) URL");
  }
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") {
    throw new Error("video/crop: `x`, `y`, `w`, `h` must be numbers");
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error("video/crop: crop rect values must be finite");
  }
  if (w <= 0 || h <= 0) {
    throw new Error("video/crop: `w` and `h` must be positive");
  }
  return { video, x, y, w, h };
}

/**
 * Clamp to even integer (FFmpeg encoder friendliness).
 * @param value - The dimension to clamp
 * @returns The value rounded down to an even integer, with a floor of 2
 */
function evenInt(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Crop a video to the given rectangle via FFmpeg's `crop` filter, clamping
 * the width/height to even integers for encoder compatibility.
 * @param rawParams - Raw mini-tool params carrying the video URL and crop rect
 * @param ctx - Local-handler context (temp dir, user / project / task ids)
 * @returns A single-output result with the cropped video URL and zero cost
 */
const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, x, y, w, h } = parseParams(rawParams);
  const cropW = evenInt(w);
  const cropH = evenInt(h);
  const cropX = Math.max(0, Math.floor(x));
  const cropY = Math.max(0, Math.floor(y));

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-vf", `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);

  const url = await uploadTempFileToStorage({
    path: outputPath,
    userId: ctx.userId,
    projectId: ctx.projectId,
    taskType: ctx.taskType,
    ext: ".mp4",
    contentType: "video/mp4",
  });

  return { outputs: [{ url }], cost: 0 };
};

export default handler;
