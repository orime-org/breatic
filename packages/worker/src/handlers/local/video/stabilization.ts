// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Video "stabilization" handler — equal-ratio symmetric crop.
 *
 * This is NOT true motion-compensated stabilization (no
 * vidstabdetect + vidstabtransform). It mirrors the pre-migration
 * browser ffmpeg.wasm behaviour in
 * `videoStabilizationWithFfmpeg.ts`, which also just crops the edges
 * inward — a visual "stabilization-ish" effect that hides shaky
 * borders without re-tracking the subject.
 *
 * If/when a true vidstab pipeline is wanted, register it under a
 * distinct tool name (e.g. `video.stabilize-true`) and keep this one
 * for visual parity with the legacy front-end.
 *
 * Params:
 *   video:   http(s) URL
 *   cropPct: 0 .. 14 — symmetric crop percentage off each edge
 *                       (0 is a no-op short-circuit)
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "@worker/handlers/local/index.js";
import { downloadToTempDir } from "@worker/handlers/local/runtime/download.js";
import { uploadTempFileToStorage } from "@worker/handlers/local/runtime/upload.js";
import { spawnCollected } from "@worker/handlers/local/runtime/spawn.js";

interface StabilizationParams {
  video: string;
  cropPct: number;
}

const MAX_CROP_PCT = 14;

/**
 * Validate and normalise the raw job params into a typed stabilization payload.
 * @param raw - Raw mini-tool params from the job payload
 * @returns The validated `{ video, cropPct }` stabilization params
 * @throws {Error} when `video` is not an http(s) URL or `cropPct` is outside [0, MAX_CROP_PCT]
 */
function parseParams(raw: Record<string, unknown>): StabilizationParams {
  const video = raw.video;
  const cropPct = raw.cropPct;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/stabilization: `video` must be an http(s) URL");
  }
  if (typeof cropPct !== "number" || !Number.isFinite(cropPct)) {
    throw new Error("video/stabilization: `cropPct` must be a finite number");
  }
  if (cropPct < 0 || cropPct > MAX_CROP_PCT) {
    throw new Error(`video/stabilization: \`cropPct\` must be within [0, ${MAX_CROP_PCT}]`);
  }
  return { video, cropPct };
}

/**
 * Symmetric crop filter — matches the legacy front-end exactly so
 * results after migration are visually identical.
 *
 * Uses `trunc(... /2)*2` on both dimensions and offsets because x264
 * rejects odd sizes with its default chroma sub-sampling.
 * @param cropPct - Symmetric crop percentage off each edge
 * @returns The FFmpeg `crop=...` filter string with even-rounded dimensions
 */
function buildCropFilter(cropPct: number): string {
  const p = cropPct / 100;
  return `crop=trunc(iw*(1-2*${p})/2)*2:trunc(ih*(1-2*${p})/2)*2:trunc(iw*${p}/2)*2:trunc(ih*${p}/2)*2,setsar=1`;
}

/**
 * Hide shaky borders by symmetrically cropping the frame inward via FFmpeg.
 * A `cropPct` of 0 short-circuits and returns the source URL unchanged.
 * @param rawParams - Raw mini-tool params carrying the video URL and crop percentage
 * @param ctx - Local-handler context (temp dir, user / project / task ids)
 * @returns A single-output result with the cropped video URL and zero cost
 */
const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, cropPct } = parseParams(rawParams);

  if (cropPct <= 0) {
    // Neutral — no re-encode, return source.
    return { outputs: [{ url: video }], cost: 0 };
  }

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  const vf = buildCropFilter(cropPct);

  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
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
