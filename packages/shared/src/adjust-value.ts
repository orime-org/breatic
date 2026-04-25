/**
 * `AdjustValue` is the shared parameter shape for every image/video
 * adjust mini-tool (client UI panel, client pre-migration ffmpeg.wasm
 * path, Worker Sharp handler, Worker FFmpeg handler). One source of
 * truth prevents the front-end sliders and back-end filters from
 * silently drifting in semantics.
 *
 * All values are slider-normalised to [-100, 100] except noise /
 * sharpness / vignette / grain which are [0, 100]. The neutral value
 * (`defaultAdjustValue`) is all-zeros.
 *
 * `buildAdjustVideoFilter()` is the canonical FFmpeg `-vf` filter
 * chain builder. Kept here so Worker's `handlers/local/video/adjust.ts`
 * and legacy front-end paths can use identical construction logic.
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

/** True when `value` has no effect (all sliders at default). */
export function isAdjustValueNeutral(value: AdjustValue): boolean {
  const keys = Object.keys(defaultAdjustValue) as (keyof AdjustValue)[];
  return keys.every((k) => value[k] === defaultAdjustValue[k]);
}

/** Coerce any-value `raw` into an `AdjustValue`, filling gaps with defaults. */
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

/** Clamp value/divisor to [-1, 1]. */
function toUnit(value: number, divisor = 100): number {
  return Math.max(-1, Math.min(1, value / divisor));
}

/**
 * Build the FFmpeg `-vf` chain string matching the front-end adjust
 * UI's intent. Identical to the pre-migration browser ffmpeg.wasm
 * implementation so behaviour after the Worker migration is visually
 * unchanged.
 *
 * Consumers (Worker): pass the returned string after `-vf` into the
 * FFmpeg argv.
 *
 * Consumers must check {@link isAdjustValueNeutral} first and skip
 * the re-encode when true — that's a significant win on no-op
 * adjust saves.
 */
export function buildAdjustVideoFilter(value: AdjustValue): string {
  const parts: string[] = [];

  const brightness = toUnit(
    value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2 + value.fade * 0.15,
  );
  const contrastF = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
  const satF = toUnit(value.saturation * 0.85 + value.vibrance * 0.45 - value.fade * 0.15);
  const fadeBump = (Math.max(0, value.fade) / 100) * 0.12;
  const br = Math.max(-1, Math.min(1, brightness + fadeBump));
  const contrast = Math.min(3, Math.max(0.01, 1 + contrastF * 0.85));
  const saturation = Math.min(4, Math.max(0, 1 + satF));

  parts.push(
    `eq=brightness=${br.toFixed(5)}:contrast=${contrast.toFixed(5)}:saturation=${saturation.toFixed(5)}`,
  );

  const hueRotation = toUnit(-value.hue, 180);
  if (Math.abs(hueRotation) > 1e-5) {
    const h = hueRotation * Math.PI;
    parts.push(`hue=h=${h.toFixed(6)}`);
  }

  const blur = Math.max(0, Math.min(1, value.noiseReduction / 100));
  if (blur > 1e-4) {
    parts.push(`gblur=sigma=${(blur * 3).toFixed(4)}`);
  }

  if (value.grain > 0.5) {
    const n = Math.min(100, Math.round(4 + value.grain * 0.5));
    parts.push(`noise=alls=${n}:allf=t+u`);
  }

  if (value.sharpness > 0.5) {
    const amt = (value.sharpness / 100) * 1.15;
    parts.push(`unsharp=5:5:${amt.toFixed(4)}:5:5:0.0`);
  }

  if (value.clarity > 0.5) {
    const amt = (value.clarity / 100) * 0.75;
    parts.push(`unsharp=7:7:${amt.toFixed(4)}:7:7:0.0`);
  }

  const tempU = toUnit(value.temperature);
  const tintU = toUnit(value.tint);
  if (Math.abs(tempU) > 1e-5 || Math.abs(tintU) > 1e-5) {
    const rr = 1 + tempU * 0.22 - tintU * 0.08;
    const gg = 1 + tempU * 0.06 + tintU * 0.2;
    const bb = 1 - tempU * 0.28 - tintU * 0.1;
    parts.push(
      `colorchannelmixer=rr=${rr.toFixed(5)}:gg=${gg.toFixed(5)}:bb=${bb.toFixed(5)}`,
    );
  }

  const vig = toUnit(value.vignette);
  if (vig > 1e-5) {
    const angle = (Math.PI / 4) * (0.35 + vig * 0.9);
    parts.push(`vignette=angle=${angle.toFixed(6)}`);
  }

  return parts.join(",");
}
