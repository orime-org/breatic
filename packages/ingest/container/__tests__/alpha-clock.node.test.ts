// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { verifyAlphaPackedClock, type AlphaPresentationClock } from '../alpha-clock.js';
import fixtures from './fixtures/alpha-clocks.json';

const vfr = fixtures.find((fixture) => fixture.name === 'vfr')!.clock;

describe('independent canonical alpha clocks (inner#1306)', () => {
  it.each(fixtures)('preserves every $name source frame duration and independent audio stream', ({ clock }) => {
    expect(verifyAlphaPackedClock(clock, structuredClone(clock))).toBe(true);
  });

  it.each(['drop-first', 'drop-last', 'duplicate-first', 'shift-pts'] as const)('rejects %s instead of publishing a partial or rebased clip', (mutation) => {
    const packed = structuredClone(vfr);
    if (mutation === 'drop-first') packed.frames.shift();
    if (mutation === 'drop-last') packed.frames.pop();
    if (mutation === 'duplicate-first') packed.frames.unshift({ ...packed.frames[0]! });
    if (mutation === 'shift-pts') packed.frames = packed.frames.map(frame => ({ ...frame, pts: String(BigInt(frame.pts) + 4096n) }));
    expect(verifyAlphaPackedClock(vfr, packed)).toBe(false);
  });

  it('compares rational instants rather than requiring identical container timescales', () => {
    const packed: AlphaPresentationClock = structuredClone(vfr);
    const [numerator, denominator] = packed.videoTimeBase.split('/');
    packed.videoTimeBase = `${numerator}/${BigInt(denominator!) * 2n}`;
    packed.frames = packed.frames.map(frame => ({ pts: String(BigInt(frame.pts) * 2n), duration: String(BigInt(frame.duration) * 2n) }));
    expect(verifyAlphaPackedClock(vfr, packed)).toBe(true);
  });

  it('rejects the measured H264 default last-duration change even when every PTS matches', () => {
    const packed = structuredClone(vfr);
    packed.frames[packed.frames.length - 1]!.duration = '5120';
    expect(verifyAlphaPackedClock(vfr, packed)).toBe(false);
  });

  it('retains the entire audio tail beyond the final video frame', () => {
    const source = fixtures.find((fixture) => fixture.name === 'audio-tail')!.clock;
    const packed = structuredClone(source);
    packed.audio[0]!.duration = '102000';
    expect(verifyAlphaPackedClock(source, packed)).toBe(false);
  });

  it('retains the independent positive audio start instead of resetting it to zero', () => {
    const source = fixtures.find((fixture) => fixture.name === 'positive-audio')!.clock;
    const packed = structuredClone(source);
    packed.audio[0]!.startPts = '0';
    expect(verifyAlphaPackedClock(source, packed)).toBe(false);
  });
});
