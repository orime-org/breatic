// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The denoise slider (inner#1305), shared by the panel that reads it and the
 * container that runs it: how far the noise comes down, as in Audacity,
 * Audition and RX. It imports nothing, so the media container's build can
 * copy it in.
 */

/**
 * Where afftdn takes the noise to sit: it takes the full amount off white noise
 * to about -50 dBFS and pink to about -60, while speech loses under 0.1 dB; a
 * higher floor starts to take speech down with it (measured on the media
 * image).
 */
export const DENOISE_NOISE_FLOOR_DB = -40;

/**
 * How far a strength takes the noise down: 0.4 dB a step, up to 40 dB.
 * @param intensity - The slider, 1 to 100.
 * @returns The reduction in dB, to one decimal.
 */
export function denoiseReductionDb(intensity: number): number {
  return Math.round(intensity * 4) / 10;
}
