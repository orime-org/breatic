// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio compressor's presets, ranges and the ffmpeg filter it runs
 * (inner#1305 §6): the panel's sliders and the container read the same
 * terms.
 */

/** Each setting's range: threshold and make-up in dB, ratio as N:1, times in ms. */
export const DYNAMICS_RANGES = {
  threshold: { min: -60, max: 0, step: 1 },
  ratio: { min: 1, max: 20, step: 0.5 },
  attack: { min: 0.1, max: 200, step: 0.1 },
  release: { min: 10, max: 2000, step: 10 },
  makeup: { min: 0, max: 24, step: 0.5 },
} as const;

/** One of the five settings. */
export type DynamicsField = keyof typeof DYNAMICS_RANGES;

/** The five settings. */
export type DynamicsSettings = Record<DynamicsField, number>;

/** The named settings. */
export const DYNAMICS_PRESETS = {
  light: { threshold: -18, ratio: 2, attack: 20, release: 250, makeup: 2 },
  medium: { threshold: -24, ratio: 3, attack: 10, release: 200, makeup: 4 },
  heavy: { threshold: -30, ratio: 6, attack: 5, release: 150, makeup: 6 },
} as const satisfies Record<string, DynamicsSettings>;

/** One of {@link DYNAMICS_PRESETS}. */
export type DynamicsPreset = keyof typeof DYNAMICS_PRESETS;

/** Each preset's name on screen, the same in every language. */
export const DYNAMICS_PRESET_LABELS: Readonly<Record<DynamicsPreset | "custom", string>> = {
  light: "Light",
  medium: "Medium",
  heavy: "Heavy",
  custom: "Custom",
};

/** What the compressor panel holds and sends. */
export interface DynamicsValue extends DynamicsSettings {
  preset: DynamicsPreset | "custom";
}

/**
 * A preset as a value of its own.
 * @param preset - The preset.
 * @returns The value.
 */
export function dynamicsValueOfPreset(preset: DynamicsPreset): DynamicsValue {
  return { preset, ...DYNAMICS_PRESETS[preset] };
}

/** The settings the panel opens on. */
export const defaultDynamicsValue: DynamicsValue = dynamicsValueOfPreset("medium");

/**
 * A level in dB as the linear factor acompressor takes.
 * @param db - The level.
 * @returns The factor, to six places.
 */
function linear(db: number): string {
  return (10 ** (db / 20)).toFixed(6);
}

/**
 * The compressor filter.
 * @param value - The settings.
 * @returns The `-af` filter.
 */
export function buildCompressorFilter(value: DynamicsValue): string {
  return (
    `acompressor=threshold=${linear(value.threshold)}:ratio=${value.ratio}:attack=${value.attack}` +
    `:release=${value.release}:makeup=${linear(value.makeup)}:knee=2.8`
  );
}
