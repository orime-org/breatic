// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import type { LocalHandlerFn, LocalHandlerResult } from "@worker/handlers/local/index.js";
import { downloadToTempDir } from "@worker/handlers/local/runtime/download.js";
import { uploadTempFileToStorage } from "@worker/handlers/local/runtime/upload.js";
import { spawnCollected } from "@worker/handlers/local/runtime/spawn.js";

interface AdjustParams {
  video: string;
  value: AdjustValue;
}

/**
 * Validate and normalise the raw job params into a typed adjust payload.
 * @param raw - Raw mini-tool params from the job payload
 * @returns The validated `{ video, value }` adjust params
 * @throws {Error} when `video` is not an http(s) URL
 */
function parseParams(raw: Record<string, unknown>): AdjustParams {
  const video = raw.video;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/adjust: `video` must be an http(s) URL");
  }
  return { video, value: parseAdjustValue(raw.value) };
}

/**
 * Apply the brightness/contrast/etc. adjust filter chain to a video via FFmpeg.
 * Neutral (all-zero) values short-circuit and return the source URL unchanged.
 * @param rawParams - Raw mini-tool params carrying the video URL and adjust value
 * @param ctx - Local-handler context (temp dir, user / project / task ids)
 * @returns A single-output result with the adjusted video URL and zero cost
 */
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
