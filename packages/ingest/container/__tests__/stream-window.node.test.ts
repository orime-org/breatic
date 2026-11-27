// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import { declaresAudioWindow, decodedAudioAccumulator, videoPacketAccumulator, type StreamWindow } from '@ingest/container/stream-window.js';

// Measured on a VP9 + Opus WebM from FFmpeg 7.1: packets run from -7 ms to 3014 ms, while decoding drops the 312-sample
// pre-skip at the start and trims the last frame to 312 samples, so the stream plays from 0 to 2994 ms + 312 samples.
const OPUS = { index: 1, codec_type: 'audio', time_base: '1/1000', sample_rate: '48000', start_pts: -7 };
const FRAMES = [{ pts: 0, nb_samples: 648 }, { pts: 14, nb_samples: 960 }, { pts: 2994, nb_samples: 312 }];

/**
 * Whether an exact pair equals a decimal number of seconds given as a fraction.
 * @param value - The pair.
 * @param numerator - The expected numerator.
 * @param denominator - The expected denominator.
 * @returns True when equal.
 */
function equals(value: readonly [bigint, bigint], numerator: bigint, denominator: bigint): boolean {
  return value[0] * denominator === numerator * value[1];
}

/**
 * Feed decoded frames to the audio accumulator, as the streamed reader does line by line.
 * @param stream - The ffprobe audio stream.
 * @param frames - The frames' fields.
 * @returns The window, or null when a clock fact is missing or nothing was decoded.
 */
function decodedAudioWindow(stream: Record<string, unknown>, frames: readonly Record<string, unknown>[]): StreamWindow | null {
  const accumulator = decodedAudioAccumulator(stream);
  if (accumulator === null) return null;
  for (const frame of frames) if (!accumulator.add(frame)) return null;
  return accumulator.window();
}

describe('the decoded audio window', () => {
  it('starts at the first decoded frame and ends where the latest decoded frame ends', () => {
    const window = decodedAudioWindow(OPUS, FRAMES)!;
    expect(equals(window.start, 0n, 1n)).toBe(true);
    // 2994 ms + 312 / 48000 s = 144024 / 48000 s.
    expect(equals(window.end, 144024n, 48000n)).toBe(true);
  });

  it('a stream with only a start declares no window, so its frames are read', () => {
    expect(declaresAudioWindow(OPUS)).toBe(false);
    expect(declaresAudioWindow({ ...OPUS, duration_ts: 3000 })).toBe(true);
  });

  it('answers null when a clock fact is missing or nothing was decoded', () => {
    expect(decodedAudioWindow(OPUS, [])).toBeNull();
    expect(decodedAudioWindow({ ...OPUS, sample_rate: undefined }, FRAMES)).toBeNull();
    expect(decodedAudioWindow({ ...OPUS, time_base: '1/0' }, FRAMES)).toBeNull();
    expect(decodedAudioWindow(OPUS, [{ pts: 0 }])).toBeNull();
  });
});

describe('the video packet window', () => {
  const VP9 = { index: 0, codec_type: 'video', time_base: '1/1000' };

  it('runs from the earliest packet to the latest packet end, on the stream clock', () => {
    const accumulator = videoPacketAccumulator(VP9)!;
    for (const fields of [{ pts: 40, duration: 40 }, { pts: 0, duration: 40 }, { pts: 2960, duration: 40 }]) expect(accumulator.add(fields)).toBe(true);
    expect(accumulator.window()).toEqual({ start: [0n, 1000n], end: [3000n, 1000n] });
  });

  it('ends a last packet without a duration after the largest known packet duration', () => {
    const accumulator = videoPacketAccumulator(VP9)!;
    for (const fields of [{ pts: 0, duration: 40 }, { pts: 40, duration: 100 }, { pts: 140 }]) accumulator.add(fields);
    expect(accumulator.window()).toEqual({ start: [0n, 1000n], end: [240n, 1000n] });
  });

  it('knows no window when no packet carries a duration or a packet has no timestamp', () => {
    const untimed = videoPacketAccumulator(VP9)!;
    untimed.add({ pts: 0 });
    expect(untimed.window()).toBeNull();
    const broken = videoPacketAccumulator(VP9)!;
    expect(broken.add({ pts: 'N/A', duration: 40 })).toBe(false);
    expect(broken.window()).toBeNull();
  });
});
