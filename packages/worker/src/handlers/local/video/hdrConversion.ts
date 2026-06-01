/**
 * Video "HDR conversion" handler — eq/unsharp colour enhancement.
 *
 * Not true HDR conversion (which would require HDR10/HLG/Dolby Vision
 * signalling + a real tone-mapping pipeline). Mirrors the pre-migration
 * browser ffmpeg.wasm behaviour in `videoHdrConversionWithFfmpeg.ts`:
 * the `preset` is a forward-compat payload (reserved for a future AI
 * routing backend), and the actual visual change is an `eq` filter
 * (contrast + saturation) + optional `unsharp` when `aiEnhance` is on.
 * The encoded stream stays tagged as Rec.709 for web decode stability.
 *
 * If/when a real HDR pipeline is wanted, register it under a distinct
 * tool name (e.g. `video.hdr-convert-ai`) and keep this one for
 * visual parity with the legacy front-end.
 *
 * Params:
 *   video:     http(s) URL
 *   preset:    "hdr10" | "hlg" | "dolby-vision"
 *              (informational — controls `-colorspace/-color_primaries/
 *               -color_trc` tagging; no signal-level tone-mapping)
 *   intensity: 0..100 — slider strength (clamped)
 *   aiEnhance: boolean — when true, adds local sharpening and
 *              uses a slower/higher-quality encode.
 */

import { join } from "node:path";
import type { LocalHandlerFn, LocalHandlerResult } from "@worker/handlers/local/index.js";
import { downloadToTempDir } from "@worker/handlers/local/runtime/download.js";
import { uploadTempFileToStorage } from "@worker/handlers/local/runtime/upload.js";
import { spawnCollected } from "@worker/handlers/local/runtime/spawn.js";

const HDR_PRESETS = ["hdr10", "hlg", "dolby-vision"] as const;
type HdrOutputPreset = typeof HDR_PRESETS[number];

interface HdrConversionParams {
  video: string;
  preset: HdrOutputPreset;
  intensity: number;
  aiEnhance: boolean;
}

/**
 * Validate and normalise the raw job params into a typed HDR-conversion payload.
 * @param raw - Raw mini-tool params from the job payload
 * @returns The validated `{ video, preset, intensity, aiEnhance }` params
 * @throws {Error} when any field is missing, wrongly typed, or out of range
 */
function parseParams(raw: Record<string, unknown>): HdrConversionParams {
  const video = raw.video;
  const preset = raw.preset;
  const intensity = raw.intensity;
  const aiEnhance = raw.aiEnhance;
  if (typeof video !== "string" || !/^https?:\/\//i.test(video)) {
    throw new Error("video/hdr-conversion: `video` must be an http(s) URL");
  }
  if (typeof preset !== "string" || !(HDR_PRESETS as readonly string[]).includes(preset)) {
    throw new Error(
      `video/hdr-conversion: \`preset\` must be one of ${HDR_PRESETS.join(", ")}`,
    );
  }
  if (typeof intensity !== "number" || !Number.isFinite(intensity)) {
    throw new Error("video/hdr-conversion: `intensity` must be a finite number");
  }
  if (intensity < 0 || intensity > 100) {
    throw new Error("video/hdr-conversion: `intensity` must be within [0, 100]");
  }
  if (typeof aiEnhance !== "boolean") {
    throw new Error("video/hdr-conversion: `aiEnhance` must be a boolean");
  }
  return { video, preset: preset as HdrOutputPreset, intensity, aiEnhance };
}

/**
 * Preset → colorspace tagging. Front-end currently returns bt709 for
 * all presets (web decode stability); preserved here verbatim so the
 * handler stays a drop-in replacement. The `preset` parameter is still
 * carried on the task for future routing to a real HDR backend.
 * @param _preset - Requested output preset (reserved; currently unused)
 * @returns The FFmpeg colorspace tagging args (always Rec.709)
 */
function buildPresetTuningArgs(_preset: HdrOutputPreset): string[] {
  return ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
}

/**
 * Build the non-AI `eq` filter chain (contrast + saturation) scaled by intensity.
 * @param intensity - Slider strength in [0, 100]
 * @returns The FFmpeg `-vf` filter string
 */
function buildTraditionalFilter(intensity: number): string {
  const i = intensity / 100;
  const saturation = (1 + i * 0.22).toFixed(4);
  const contrast = (1 + i * 0.15).toFixed(4);
  return `eq=contrast=${contrast}:saturation=${saturation},setsar=1`;
}

/**
 * Build the AI-enhance `eq` + `unsharp` filter chain scaled by intensity.
 * @param intensity - Slider strength in [0, 100]
 * @returns The FFmpeg `-vf` filter string including local sharpening
 */
function buildAiEnhanceFilter(intensity: number): string {
  const i = intensity / 100;
  const saturation = (1 + i * 0.28).toFixed(4);
  const contrast = (1 + i * 0.2).toFixed(4);
  const sharpness = (0.18 + i * 0.9).toFixed(4);
  return `eq=contrast=${contrast}:saturation=${saturation},unsharp=7:7:${sharpness}:7:7:0.0,setsar=1`;
}

/**
 * Apply the colour-enhancement ("HDR conversion") filter chain to a video,
 * choosing the AI-enhance or traditional path based on `aiEnhance`.
 * @param rawParams - Raw mini-tool params carrying the video URL, preset, intensity and aiEnhance flag
 * @param ctx - Local-handler context (temp dir, user / project / task ids)
 * @returns A single-output result with the enhanced video URL and zero cost
 */
const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { video, preset, intensity, aiEnhance } = parseParams(rawParams);

  const inputPath = await downloadToTempDir(video, ctx.tempDir, { suffix: ".mp4" });
  const outputPath = join(ctx.tempDir, "out.mp4");

  const vf = aiEnhance
    ? buildAiEnhanceFilter(intensity)
    : buildTraditionalFilter(intensity);
  const presetArgs = buildPresetTuningArgs(preset);
  // Quality/speed asymmetry matches the front-end: aiEnhance pays
  // for a slower encode in exchange for cleaner sharpening output.
  const x264Preset = aiEnhance ? "medium" : "veryfast";
  const x264Crf = aiEnhance ? "21" : "23";

  await spawnCollected("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.1",
    "-preset", x264Preset,
    "-pix_fmt", "yuv420p",
    "-crf", x264Crf,
    ...presetArgs,
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
