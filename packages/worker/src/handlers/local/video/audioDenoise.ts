/**
 * Video audio-denoise handler — FFmpeg `afftdn` (FFT denoise).
 *
 *   intensity: number in [0, 100] — 0 is neutral (returns source),
 *     100 is aggressive. Maps to FFmpeg afftdn's `nf` (noise floor dB)
 *     and `nr` (reduction dB). Values below 1 short-circuit.
 *
 * Video stream is copied (no re-encode), only audio is processed.
 * Keeps the file small + avoids quality loss on the video track.
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "@worker/handlers/local/index.js";
import { downloadToTempDir } from "@worker/handlers/local/runtime/download.js";
import { uploadTempFileToStorage } from "@worker/handlers/local/runtime/upload.js";
import { spawnCollected } from "@worker/handlers/local/runtime/spawn.js";

interface DenoiseParams {
  video: string;
  intensity: number;
}

function parseParams(raw: Record<string, unknown>): DenoiseParams {
  const video = raw.video;
  const intensity = raw.intensity;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/audio-denoise: `video` must be an http(s) URL");
  }
  if (typeof intensity !== "number" || !Number.isFinite(intensity)) {
    throw new Error("video/audio-denoise: `intensity` must be a finite number");
  }
  if (intensity < 0 || intensity > 100) {
    throw new Error("video/audio-denoise: `intensity` must be within [0, 100]");
  }
  return { video, intensity };
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, intensity } = parseParams(rawParams);

  if (intensity < 1) {
    // Neutral intensity — skip the re-encode, source is unchanged.
    return { outputs: [{ url: video }], cost: 0 };
  }

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  // afftdn parameters mapped from a single slider:
  //   nf (noise floor, dB): -80 → -40 as intensity goes 1 → 100
  //     (higher = treats more audio as noise → more aggressive)
  //   nr (reduction, dB):   3   → 36  as intensity goes 1 → 100
  const nf = -80 + (intensity / 100) * 40;
  const nr = 3 + (intensity / 100) * 33;
  const af = `afftdn=nf=${nf.toFixed(2)}:nr=${nr.toFixed(2)}`;

  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-c:v", "copy",
    "-af", af,
    "-c:a", "aac",
    "-b:a", "128k",
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
