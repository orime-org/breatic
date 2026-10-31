// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { AUDIO_PEAK_RATE, encodeAudioPeaks, peakBuckets } from "@shared/audio-peaks.js";
import { audioPeaksSchema } from "@shared/upload/peaks.js";

/**
 * Float32 little-endian bytes, as ffmpeg's `f32le` writes them.
 * @param samples - The samples.
 * @returns Their bytes.
 */
function bytesOf(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  return out;
}

describe("peakBuckets", () => {
  it("reads at 8 kHz", () => {
    expect(AUDIO_PEAK_RATE).toBe(8000);
  });

  it("keeps the loudest sample of each of 1000 equal stretches", () => {
    const samples = Array.from({ length: 4000 }, (_, i) => (i % 4 === 1 ? -0.5 : 0.1));
    const buckets = peakBuckets(4000);
    buckets.add(bytesOf(samples));
    const peaks = buckets.finish();
    expect(peaks).toHaveLength(1000);
    expect(peaks.every((peak) => peak === 128)).toBe(true);
  });

  it("splits stretches that do not divide evenly without losing a sample", () => {
    const buckets = peakBuckets(2500);
    const samples = Array.from({ length: 2500 }, () => 0);
    samples[2499] = 1;
    buckets.add(bytesOf(samples));
    const peaks = buckets.finish();
    expect(peaks).toHaveLength(1000);
    expect(peaks[999]).toBe(255);
    expect(peaks.slice(0, 999).every((peak) => peak === 0)).toBe(true);
  });

  it("gives one value per sample when there are fewer than 1000", () => {
    const buckets = peakBuckets(3);
    buckets.add(bytesOf([0.25, -1, 0]));
    expect(buckets.finish()).toEqual([64, 255, 0]);
  });

  it("reads silence as zero and holds anything louder than full scale at 255", () => {
    const buckets = peakBuckets(2);
    buckets.add(bytesOf([0, 1.7]));
    expect(buckets.finish()).toEqual([0, 255]);
  });

  it("takes bytes in pieces that split a sample", () => {
    const whole = bytesOf([0.5, -0.25, 1]);
    const buckets = peakBuckets(3);
    buckets.add(whole.subarray(0, 3));
    buckets.add(whole.subarray(3, 9));
    buckets.add(whole.subarray(9));
    expect(buckets.finish()).toEqual([128, 64, 255]);
  });

  it("puts samples past the expected count in the last stretch", () => {
    const buckets = peakBuckets(2);
    buckets.add(bytesOf([0, 0, 0, 0.5]));
    expect(buckets.finish()).toEqual([0, 128]);
  });

  it("leaves the stretches a short read never reached at zero", () => {
    const buckets = peakBuckets(4);
    buckets.add(bytesOf([1]));
    expect(buckets.finish()).toEqual([255, 0, 0, 0]);
  });

  it("refuses an expected count that is not a positive whole number", () => {
    expect(() => peakBuckets(0)).toThrow(RangeError);
    expect(() => peakBuckets(Number.NaN)).toThrow(RangeError);
  });
});

describe("encodeAudioPeaks", () => {
  it("writes a file the page accepts", () => {
    const encoded = encodeAudioPeaks([0, 128, 255]);
    expect(audioPeaksSchema.parse(JSON.parse(new TextDecoder().decode(encoded)))).toEqual({
      version: 1,
      peaks: [0, 128, 255],
    });
  });
});
