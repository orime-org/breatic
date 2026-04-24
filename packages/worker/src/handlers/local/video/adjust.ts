/**
 * Video adjust handler — FFmpeg `-vf` chain built from the shared
 * `AdjustValue` via `buildAdjustVideoFilter`.
 *
 * This handler is 1:1 with the pre-migration ffmpeg.wasm front-end
 * path — the filter chain construction lives in `@breatic/shared`'s
 * `buildAdjustVideoFilter`, consumed identically by both client and
 * server, so visual results don't drift after the migration.
 *
 * Neutral `value` (all-zeros) short-circuits: returns the source URL
 * unchanged, no re-encode.
 */

import { join } from "node:path";
import {
  buildAdjustVideoFilter,
  isAdjustValueNeutral,
  parseAdjustValue,
  type AdjustValue,
} from "@breatic/shared";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { downloadToTempDir } from "../runtime/download.js";
import { uploadTempFileToStorage } from "../runtime/upload.js";
import { spawnCollected } from "../runtime/spawn.js";

interface AdjustParams {
  video: string;
  value: AdjustValue;
}

function parseParams(raw: Record<string, unknown>): AdjustParams {
  const video = raw.video;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/adjust: `video` must be an http(s) URL");
  }
  return { video, value: parseAdjustValue(raw.value) };
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, value } = parseParams(rawParams);

  if (isAdjustValueNeutral(value)) {
    return { outputs: [{ url: video }], cost: 0 };
  }

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  const vf = buildAdjustVideoFilter(value);

  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
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
