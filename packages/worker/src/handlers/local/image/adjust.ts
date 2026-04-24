/**
 * Image adjust handler — Sharp-based color / tone adjustments.
 *
 * Accepts the shared `AdjustValue` shape (15 sliders: exposure,
 * highlights, shadows, contrast, saturation, vibrance, temperature,
 * tint, hue, sharpness, noiseReduction, clarity, vignette, grain,
 * fade). The subset Sharp can express natively is applied directly;
 * effects Sharp can't model (true vignette, grain, film fade) are
 * approximated or dropped. This matches the ffmpeg.wasm-era
 * front-end `buildAdjustFabricFilters` fidelity — not every slider
 * maps to every backend, but the common subset stays consistent.
 *
 * Pipeline:
 *   1. modulate  — brightness/saturation/hue
 *   2. linear    — contrast via slope/intercept
 *   3. gamma     — shadow/highlight lift
 *   4. recomb    — temperature/tint via channel-mix matrix
 *   5. blur      — noise reduction (optional, when slider > threshold)
 *   6. sharpen   — sharpness / clarity (optional)
 *
 * Neutral `value` (all zeros) short-circuits — no re-encode, returns
 * the source URL unchanged.
 */

import sharp from "sharp";
import { parseAdjustValue, isAdjustValueNeutral, type AdjustValue } from "@breatic/shared";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { uploadBufferToStorage } from "../runtime/upload.js";

interface AdjustParams {
  image: string;
  value: AdjustValue;
}

function parseParams(raw: Record<string, unknown>): AdjustParams {
  const image = raw.image;
  if (typeof image !== "string" || !/^https?:\/\//i.test(image)) {
    throw new Error("image/adjust: `image` must be an http(s) URL");
  }
  const value = parseAdjustValue(raw.value);
  return { image, value };
}

/** Clamp the slider's [-100, 100] input to [-1, 1]. */
function toUnit(v: number, divisor = 100): number {
  return Math.max(-1, Math.min(1, v / divisor));
}

function applyAdjust(pipeline: sharp.Sharp, value: AdjustValue): sharp.Sharp {
  let p = pipeline;

  // 1. modulate — brightness / saturation / hue (degrees)
  const brightness = Math.max(
    0.1,
    Math.min(2.5, 1 + toUnit(value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2) * 0.5),
  );
  const saturation = Math.max(0, Math.min(4, 1 + toUnit(value.saturation * 0.85 + value.vibrance * 0.45)));
  const hueDeg = Math.max(-180, Math.min(180, -toUnit(value.hue, 180) * 180));
  if (brightness !== 1 || saturation !== 1 || hueDeg !== 0) {
    p = p.modulate({
      brightness,
      saturation,
      ...(hueDeg !== 0 ? { hue: hueDeg } : {}),
    });
  }

  // 2. linear — contrast (slope), fade (offset raise towards gray)
  const contrastUnit = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
  const slope = Math.max(0.01, Math.min(3, 1 + contrastUnit * 0.85));
  // Fade pushes towards 128/255 gray; implement as offset.
  const fadeOffset = Math.max(0, value.fade) * 0.3;
  if (slope !== 1 || fadeOffset !== 0) {
    p = p.linear(slope, fadeOffset);
  }

  // 3. gamma — shadow/highlight roll-off (range 1..3 Sharp allows)
  // gamma >1 lifts shadows, <1 deepens. Map shadows slider linearly.
  const gamma = Math.max(1.0, Math.min(3.0, 1.0 + toUnit(value.shadows) * 0.5));
  if (gamma !== 1.0) {
    p = p.gamma(gamma);
  }

  // 4. recomb — temperature / tint via 3x3 channel mix
  const tempU = toUnit(value.temperature);
  const tintU = toUnit(value.tint);
  if (Math.abs(tempU) > 1e-5 || Math.abs(tintU) > 1e-5) {
    const rr = 1 + tempU * 0.22 - tintU * 0.08;
    const gg = 1 + tempU * 0.06 + tintU * 0.2;
    const bb = 1 - tempU * 0.28 - tintU * 0.1;
    p = p.recomb([
      [rr, 0, 0],
      [0, gg, 0],
      [0, 0, bb],
    ]);
  }

  // 5. blur — noise reduction
  const blur = Math.max(0, Math.min(1, value.noiseReduction / 100));
  if (blur > 1e-4) {
    p = p.blur(blur * 3);
  }

  // 6. sharpen — sharpness + clarity both feed Sharp's `sharpen`
  const sharpen = Math.max(0, Math.min(1, (value.sharpness + value.clarity) / 200));
  if (sharpen > 1e-4) {
    p = p.sharpen({ sigma: 1 + sharpen * 2 });
  }

  // vignette / grain: Sharp has no native primitive. Skipped here.
  // Callers that need them should stay on video/adjust (FFmpeg) or
  // request a future image/adjust-vignette extension. Documented as a
  // known gap to avoid silently mis-rendering.

  return p;
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { image, value } = parseParams(rawParams);

  if (isAdjustValueNeutral(value)) {
    // No-op save: skip the fetch+re-encode round-trip. The front-end
    // is expected to short-circuit before even calling the mini-tool,
    // but enforce it here too for defensive redundancy.
    return { url: image, cost: 0 };
  }

  const response = await fetch(image);
  if (!response.ok) {
    throw new Error(`image/adjust: download failed (HTTP ${response.status}) for ${image}`);
  }
  const sourceBuffer = Buffer.from(await response.arrayBuffer());

  const outputBuffer = await applyAdjust(sharp(sourceBuffer), value).png().toBuffer();

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
