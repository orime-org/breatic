// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio equaliser's ten bands, its presets and the ffmpeg filter it runs
 * (inner#1305 §6): the panel's sliders and the container read the same
 * terms, so what the reader set and what is applied cannot drift apart.
 */

/** Each band's centre, an octave apart. */
export const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** How far each band moves, in dB. */
export const EQ_GAIN_RANGE = { min: -12, max: 12, step: 1 } as const;

/** The named curves, one gain per band from 31 Hz up. */
export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass_boost: [6, 6, 4, 2, 0, 0, 0, 0, 0, 0],
  bass_cut: [-6, -6, -4, -2, 0, 0, 0, 0, 0, 0],
  treble_boost: [0, 0, 0, 0, 0, 0, 2, 4, 6, 6],
  treble_cut: [0, 0, 0, 0, 0, 0, -2, -4, -6, -6],
  voice: [-6, -4, -2, 0, 0, 2, 3, 3, 1, 0],
  telephone: [-12, -12, -12, -6, 0, 3, 3, 0, -12, -12],
} as const satisfies Record<string, readonly number[]>;

/** One of {@link EQ_PRESETS}. */
export type EqPreset = keyof typeof EQ_PRESETS;

/** Each preset's name on screen, the same in every language. */
export const EQ_PRESET_LABELS: Readonly<Record<EqPreset | "custom", string>> = {
  flat: "Flat",
  bass_boost: "Bass boost",
  bass_cut: "Bass cut",
  treble_boost: "Treble boost",
  treble_cut: "Treble cut",
  voice: "Voice",
  telephone: "Telephone",
  custom: "Custom",
};

/** What the equaliser panel holds and sends: the curve, and the preset it came from. */
export interface EqValue {
  preset: EqPreset | "custom";
  gains: number[];
}

/**
 * A preset as a value of its own, its gains copied.
 * @param preset - The preset.
 * @returns The value.
 */
export function eqValueOfPreset(preset: EqPreset): EqValue {
  return { preset, gains: [...EQ_PRESETS[preset]] };
}

/** The curve the panel opens on. */
export const defaultEqValue: EqValue = eqValueOfPreset("flat");

/** The rate assumed for a source whose probe read none. */
const ASSUMED_RATE = 48000;

/**
 * The filter chain: one peaking band per gain that moves, then a limiter that
 * holds peaks under 0.89 without touching the level below them.
 * @param gains - One gain per band, from 31 Hz up.
 * @param sampleRate - The source's rate, null when its probe read none.
 * @returns The `-af` chain.
 */
export function buildEqFilter(gains: readonly number[], sampleRate: number | null): string {
  const nyquist = (sampleRate ?? ASSUMED_RATE) / 2;
  const bands = EQ_BANDS_HZ.flatMap((hz, index) => {
    const gain = gains[index] ?? 0;
    return gain === 0 || hz >= nyquist ? [] : [`equalizer=f=${hz}:t=o:w=1:g=${gain}`];
  });
  return [...bands, "alimiter=limit=0.89:level=disabled"].join(",");
}
