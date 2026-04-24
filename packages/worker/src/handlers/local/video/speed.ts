/**
 * Video speed handler — FFmpeg-based playback-rate change.
 *
 *   rate > 1 → faster (shorter duration);  rate < 1 → slower
 *
 * Video timestamps: `setpts=PTS/rate` (scalar).
 * Audio timestamps: FFmpeg's `atempo` only accepts [0.5, 100.0] per
 * pass — for rates outside that range we chain multiple atempo
 * filters (e.g. rate=0.25 → atempo=0.5,atempo=0.5).
 *
 * Output: H.264 yuv420p + AAC for maximum compatibility.
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { downloadToTempDir } from "../runtime/download.js";
import { uploadTempFileToStorage } from "../runtime/upload.js";
import { spawnCollected } from "../runtime/spawn.js";

interface SpeedParams {
  video: string;
  rate: number;
}

function parseParams(raw: Record<string, unknown>): SpeedParams {
  const video = raw.video;
  const rate = raw.rate;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/speed: `video` must be an http(s) URL");
  }
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new Error("video/speed: `rate` must be a finite number");
  }
  if (rate <= 0) {
    throw new Error("video/speed: `rate` must be positive");
  }
  if (rate < 0.1 || rate > 10) {
    throw new Error("video/speed: `rate` must be within [0.1, 10]");
  }
  return { video, rate };
}

/**
 * FFmpeg `atempo` is clamped per-instance to [0.5, 100]. Express any
 * rate as a chain of atempo filters, each within bounds. Example:
 *   rate=0.25 → "atempo=0.5,atempo=0.5"
 *   rate=4    → "atempo=2,atempo=2"
 *   rate=1.5  → "atempo=1.5"
 */
function buildAtempoChain(rate: number): string {
  if (Math.abs(rate - 1) < 1e-6) return "";
  const chain: number[] = [];
  let remaining = rate;
  while (remaining < 0.5) {
    chain.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2.0) {
    chain.push(2.0);
    remaining /= 2.0;
  }
  chain.push(remaining);
  return chain.map((r) => `atempo=${r.toFixed(6)}`).join(",");
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, rate } = parseParams(rawParams);

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  const videoFilter = `setpts=PTS/${rate.toFixed(6)}`;
  const audioFilter = buildAtempoChain(rate);

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-filter:v", videoFilter,
    ...(audioFilter ? ["-filter:a", audioFilter] : ["-an"]),
    "-c:v", "libx264",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
    ...(audioFilter ? ["-c:a", "aac", "-b:a", "128k"] : []),
    "-movflags", "+faststart",
    outputPath,
  ];

  await spawnCollected("ffmpeg", args);

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
