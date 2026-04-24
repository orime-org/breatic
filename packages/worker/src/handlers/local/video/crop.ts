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
 *   sourceUrl: string      — http(s) URL to a video in permanent storage
 *   x, y, w, h: number     — crop rectangle in source pixels (FFmpeg convention:
 *                            x/y is top-left, w/h is box size)
 *
 * Rounding: FFmpeg `crop` rejects odd widths/heights for many codecs.
 * We clamp each to an even integer via `Math.max(2, Math.floor(v / 2) * 2)`
 * which matches what `videoCropWithFfmpeg.ts` does on the frontend
 * today, so the behaviour after migration is identical.
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { downloadToTempDir } from "../runtime/download.js";
import { uploadTempFileToStorage } from "../runtime/upload.js";
import { spawnCollected } from "../runtime/spawn.js";

interface CropParams {
  sourceUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseParams(raw: Record<string, unknown>): CropParams {
  const sourceUrl = raw.sourceUrl;
  const x = raw.x;
  const y = raw.y;
  const w = raw.w;
  const h = raw.h;

  if (typeof sourceUrl !== "string" || !/^https?:\/\//.test(sourceUrl)) {
    throw new Error("video/crop: `sourceUrl` must be an http(s) URL");
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
  return { sourceUrl, x, y, w, h };
}

/** Clamp to even integer (FFmpeg encoder friendliness). */
function evenInt(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { sourceUrl, x, y, w, h } = parseParams(rawParams);
  const cropW = evenInt(w);
  const cropH = evenInt(h);
  const cropX = Math.max(0, Math.floor(x));
  const cropY = Math.max(0, Math.floor(y));

  const inputPath = await downloadToTempDir(sourceUrl, ctx.tempDir, { suffix: ".mp4" });
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

  return { url, cost: 0 };
};

export default handler;
