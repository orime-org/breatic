// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `AdjustValue` is the shared parameter shape of the adjust mini-tool: the
 * panel's sliders and the container's ffmpeg filter read the same fields,
 * so the two cannot drift apart in meaning.
 *
 * All values are slider-normalised to [-100, 100] except noise /
 * sharpness / vignette / grain which are [0, 100]. The neutral value
 * (`defaultAdjustValue`) is all-zeros.
 *
 * `buildAdjustVideoFilter()` is the canonical FFmpeg `-vf` filter
 * chain builder, which the mini-tool container's adjust operation runs.
 */

export interface AdjustValue {
  exposure: number;
  highlights: number;
  shadows: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  hue: number;
  sharpness: number;
  noiseReduction: number;
  clarity: number;
  vignette: number;
  grain: number;
  fade: number;
}

export const defaultAdjustValue: AdjustValue = {
  exposure: 0,
  highlights: 0,
  shadows: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  sharpness: 0,
  noiseReduction: 0,
  clarity: 0,
  vignette: 0,
  grain: 0,
  fade: 0,
};

/**
 * True when `value` has no effect (all sliders at default).
 * @param value - the adjust parameters to test
 * @returns `true` when every field equals its `defaultAdjustValue`
 */
export function isAdjustValueNeutral(value: AdjustValue): boolean {
  const keys = Object.keys(defaultAdjustValue) as (keyof AdjustValue)[];
  return keys.every((k) => value[k] === defaultAdjustValue[k]);
}

/**
 * Coerce any-value `raw` into an `AdjustValue`, filling gaps with defaults.
 * @param raw - untrusted input (e.g. persisted JSON) to normalise
 * @returns a complete `AdjustValue` with missing / non-finite fields set to their defaults
 */
export function parseAdjustValue(raw: unknown): AdjustValue {
  const src = (raw ?? {}) as Partial<Record<keyof AdjustValue, unknown>>;
  const out: AdjustValue = { ...defaultAdjustValue };
  for (const k of Object.keys(defaultAdjustValue) as (keyof AdjustValue)[]) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Clamp value/divisor to [-1, 1].
 * @param value - the raw slider amount
 * @param divisor - scale factor mapping the slider range onto unit range (default 100)
 * @returns `value / divisor` clamped to the [-1, 1] interval
 */
function toUnit(value: number, divisor = 100): number {
  return Math.max(-1, Math.min(1, value / divisor));
}

/** One slider's range. */
export interface AdjustRange {
  min: number;
  max: number;
}

/** Each slider's range: the four one-sided channels run from zero, the rest both ways. */
export const ADJUST_RANGES: Readonly<Record<keyof AdjustValue, AdjustRange>> = {
  exposure: { min: -100, max: 100 },
  highlights: { min: -100, max: 100 },
  shadows: { min: -100, max: 100 },
  contrast: { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
  vibrance: { min: -100, max: 100 },
  temperature: { min: -100, max: 100 },
  tint: { min: -100, max: 100 },
  hue: { min: -100, max: 100 },
  sharpness: { min: 0, max: 100 },
  noiseReduction: { min: 0, max: 100 },
  clarity: { min: -100, max: 100 },
  vignette: { min: 0, max: 100 },
  grain: { min: 0, max: 100 },
  fade: { min: -100, max: 100 },
};

/**
 * What one adjust value comes to, as numbers both the video filter and the
 * picture's filters read, so a slider means the same on either. A stage that
 * does nothing is zero, except the contrast and saturation multipliers, which
 * are one, and the channel mix, which is null.
 */
export interface AdjustTerms {
  /** Added to every channel, in [-1, 1]. */
  brightness: number;
  /** Contrast multiplier, in [0.01, 3]. */
  contrast: number;
  /** Saturation multiplier, in [0, 4]. */
  saturation: number;
  /** Hue rotation in radians. */
  hueRadians: number;
  /** Noise reduction as a share of the strongest blur, in [0, 1]. */
  blur: number;
  /** Grain strength on ffmpeg's `noise` scale, 0 for none. */
  grain: number;
  /** Sharpening amount for the 5×5 unsharp mask, 0 for none. */
  sharpen: number;
  /** Local contrast amount for the 7×7 unsharp mask, 0 for none. */
  clarity: number;
  /** Per-channel multipliers for temperature and tint, or null when neither moves. */
  channels: { r: number; g: number; b: number } | null;
  /** Vignette angle in radians, 0 for none. */
  vignetteAngle: number;
}

/**
 * The numbers one adjust value comes to.
 * @param value - The sliders.
 * @returns Its terms.
 */
export function adjustTerms(value: AdjustValue): AdjustTerms {
  const brightness = toUnit(
    value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2 + value.fade * 0.15,
  );
  const contrastF = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
  const satF = toUnit(value.saturation * 0.85 + value.vibrance * 0.45 - value.fade * 0.15);
  const fadeBump = (Math.max(0, value.fade) / 100) * 0.12;
  const hueRotation = toUnit(-value.hue, 180);
  const tempU = toUnit(value.temperature);
  const tintU = toUnit(value.tint);
  const vig = toUnit(value.vignette);
  return {
    brightness: Math.max(-1, Math.min(1, brightness + fadeBump)),
    contrast: Math.min(3, Math.max(0.01, 1 + contrastF * 0.85)),
    saturation: Math.min(4, Math.max(0, 1 + satF)),
    hueRadians: Math.abs(hueRotation) > 1e-5 ? hueRotation * Math.PI : 0,
    blur: Math.max(0, Math.min(1, value.noiseReduction / 100)),
    grain: value.grain > 0.5 ? Math.min(100, Math.round(4 + value.grain * 0.5)) : 0,
    sharpen: value.sharpness > 0.5 ? (value.sharpness / 100) * 1.15 : 0,
    clarity: value.clarity > 0.5 ? (value.clarity / 100) * 0.75 : 0,
    channels:
      Math.abs(tempU) > 1e-5 || Math.abs(tintU) > 1e-5
        ? {
            r: 1 + tempU * 0.22 - tintU * 0.08,
            g: 1 + tempU * 0.06 + tintU * 0.2,
            b: 1 - tempU * 0.28 - tintU * 0.1,
          }
        : null,
    vignetteAngle: vig > 1e-5 ? (Math.PI / 4) * (0.35 + vig * 0.9) : 0,
  };
}

/**
 * Build the FFmpeg `-vf` chain string from the value's {@link adjustTerms}.
 *
 * Consumers (Worker): pass the returned string after `-vf` into the
 * FFmpeg argv.
 *
 * Consumers must check {@link isAdjustValueNeutral} first and skip
 * the re-encode when true — that's a significant win on no-op
 * adjust saves.
 * @param value - the adjust slider values to translate into a filter chain
 * @returns the comma-joined FFmpeg `-vf` filter chain
 */
export function buildAdjustVideoFilter(value: AdjustValue): string {
  const terms = adjustTerms(value);
  const parts = [
    `eq=brightness=${terms.brightness.toFixed(5)}:contrast=${terms.contrast.toFixed(5)}:saturation=${terms.saturation.toFixed(5)}`,
  ];
  if (terms.hueRadians !== 0) parts.push(`hue=H=${terms.hueRadians.toFixed(6)}`);
  if (terms.blur > 1e-4) parts.push(`gblur=sigma=${(terms.blur * 3).toFixed(4)}`);
  if (terms.grain > 0) parts.push(`noise=alls=${terms.grain}:allf=t+u`);
  if (terms.sharpen > 0) parts.push(`unsharp=5:5:${terms.sharpen.toFixed(4)}:5:5:0.0`);
  if (terms.clarity > 0) parts.push(`unsharp=7:7:${terms.clarity.toFixed(4)}:7:7:0.0`);
  if (terms.channels !== null) {
    const { r, g, b } = terms.channels;
    parts.push(`colorchannelmixer=rr=${r.toFixed(5)}:gg=${g.toFixed(5)}:bb=${b.toFixed(5)}`);
  }
  if (terms.vignetteAngle > 0) parts.push(`vignette=angle=${terms.vignetteAngle.toFixed(6)}`);
  return parts.join(",");
}
