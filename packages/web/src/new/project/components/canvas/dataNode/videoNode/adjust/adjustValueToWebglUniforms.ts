import type { AdjustValue } from '@/new/imageEditor/components/adjust/AdjustBottomToolbar';

const toUnit = (value: number, divisor = 100) => Math.max(-1, Math.min(1, value / divisor));

/**
 * Maps {@link AdjustValue} to scalar/vector uniforms consumed by the WebGL2 adjust preview shader.
 * Tuned to follow the same composition order as `ImageNode` / `buildAdjustFabricFilters` (approximate).
 */
export function adjustValueToWebglUniforms(v: AdjustValue): {
  brightness: number;
  contrast: number;
  saturation: number;
  hueAngle: number;
  rgbGain: readonly [number, number, number];
  vignette: number;
  fadeAlpha: number;
  grain: number;
} {
  const brightness = toUnit(v.exposure * 0.9 + v.highlights * 0.25 - v.shadows * 0.2 + v.fade * 0.15);
  const contrast = toUnit(v.contrast * 0.9 + v.clarity * 0.35);
  const saturation = toUnit(v.saturation * 0.85 + v.vibrance * 0.45 - v.fade * 0.15);
  const hueRotation = toUnit(-v.hue, 180);
  const hueAngle = hueRotation * Math.PI;

  const tempUnit = toUnit(v.temperature);
  const tintUnit = toUnit(v.tint);
  const rGain = 1 + tempUnit * 0.22 - tintUnit * 0.08;
  const gGain = 1 + tempUnit * 0.06 + tintUnit * 0.2;
  const bGain = 1 - tempUnit * 0.28 - tintUnit * 0.1;

  const vignette = toUnit(v.vignette);
  const fadeAlpha = (Math.max(0, v.fade) / 100) * 0.35;
  const grain = Math.max(0, v.grain) / 100;

  return {
    brightness,
    contrast,
    saturation,
    hueAngle,
    rgbGain: [rGain, gGain, bGain] as const,
    vignette,
    fadeAlpha,
    grain,
  };
}
