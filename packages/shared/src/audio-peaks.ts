// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How an audio's peaks are read (inner#1305 §4.4): the terms the media
 * container cuts them by and the page's schema checks them against. This file
 * imports nothing, so the container's build takes it as it is.
 */

/** The most values a peaks file holds, however long the audio. */
export const AUDIO_PEAK_COUNT = 1000;

/** The value a full-scale stretch reads as. */
export const AUDIO_PEAK_MAX = 255;

/** The rate the audio is decoded at, mixed to mono, to read its peaks. */
export const AUDIO_PEAK_RATE = 8000;

/** A running read of peaks over float samples. */
export interface PeakBuckets {
  /** Take the next bytes of 32-bit little-endian float samples, in any split. */
  add: (bytes: Uint8Array) => void;
  /** The peaks read so far, one per stretch. */
  finish: () => number[];
}

/**
 * Read the loudest sample of each of up to {@link AUDIO_PEAK_COUNT} equal
 * stretches, without holding the samples. Samples past the expected count go
 * to the last stretch; stretches a short read never reached stay at zero.
 * @param expectedSamples - How many samples the audio holds at
 *   {@link AUDIO_PEAK_RATE}, from its probed length.
 * @returns The running read.
 * @throws {RangeError} When the expected count is not a positive whole number.
 */
export function peakBuckets(expectedSamples: number): PeakBuckets {
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) {
    throw new RangeError(`expected samples must be a positive whole number, got ${expectedSamples}`);
  }
  const count = Math.min(AUDIO_PEAK_COUNT, expectedSamples);
  const loudest = new Float64Array(count);
  // A sample split across two pieces waits here for its remaining bytes.
  const carry = new Uint8Array(4);
  let carried = 0;
  let index = 0;

  /**
   * Fold one sample into its stretch.
   * @param sample - The sample.
   */
  const take = (sample: number): void => {
    const bucket = Math.min(count - 1, Math.floor((index * count) / expectedSamples));
    const level = Math.abs(sample);
    if (level > (loudest[bucket] ?? 0)) loudest[bucket] = level;
    index += 1;
  };

  return {
    add(bytes) {
      let at = 0;
      while (carried > 0 && carried < 4 && at < bytes.length) carry[carried++] = bytes[at++] ?? 0;
      if (carried === 4) {
        take(new DataView(carry.buffer).getFloat32(0, true));
        carried = 0;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (; at + 4 <= bytes.length; at += 4) take(view.getFloat32(at, true));
      while (at < bytes.length) carry[carried++] = bytes[at++] ?? 0;
    },
    finish() {
      return Array.from(loudest, (level) => Math.min(AUDIO_PEAK_MAX, Math.ceil(level * AUDIO_PEAK_MAX)));
    },
  };
}

/**
 * A peaks file's bytes, in the shape the page's schema reads.
 * @param peaks - One value per stretch.
 * @returns The JSON bytes.
 */
export function encodeAudioPeaks(peaks: readonly number[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: 1, peaks }));
}
