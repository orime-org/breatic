// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D4-3/D4-4 worker builders (inner#1306 test plan §92 D4-9/D4-10; frames-split design §7.17 「唯一写点：worker的配方构造」,
 * frame and segment rows, §4.3 奇数行, §5.4).
 *
 * Pure builders in `video-presentation-recipes.ts`: from the full ledger and the execution-level selection, which stays in
 * presentation coordinates (`{ frameIndex, pts }`, `{ range }` in seconds, D4-10), they write the job-level recipes. Every
 * case's first frame is a source keyframe (cfr96: 0 and 48), so the decodeStart rule under review (§91 W7) does not
 * change them. The fixtures are the container-written ledgers of fixtures/presentation (PROVENANCE.txt).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as recipes from '@worker/handlers/video-presentation-recipes.js';

type Exact = { numerator: string; denominator: string };
const r = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const INPUT = '00000000-0000-4000-8000-000000000001';
const CARRIER = { crf: 18, preset: 'medium', maxShortSide: 1080 };
const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/presentation/${name}.ledger.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

/**
 * A builder exported from the recipes module, read at call time.
 * @param name - Its export name.
 * @returns It.
 */
function builder<T>(name: string): T {
  const fn = (recipes as Record<string, unknown>)[name];
  expect(fn, `${name} is exported from video-presentation-recipes`).toBeTypeOf('function');
  return fn as T;
}
type FrameBuilder = (ledger: unknown, selection: { frameIndex: number; pts: number }, inputId: string) => Record<string, unknown>;
type SegmentBuilder = (ledger: unknown, selection: { range: { start: number; end: number } }, inputId: string, carrier: typeof CARRIER) => Record<string, unknown>[];

/**
 * cfr96 with its plan edited (the derived fields that must agree are edited with it by the caller).
 * @param edit - The change to the plan.
 * @returns The ledger.
 */
function cfr96(edit?: (plan: Record<string, Record<string, unknown>>) => void): Record<string, unknown> {
  const ledger = read('cfr96');
  edit?.(ledger.plan as Record<string, Record<string, unknown>>);
  return ledger;
}

describe('the frame recipe from the full ledger (§92 D4-3; design §7.17 frame row)', () => {
  it('TB01 a presented frame becomes its source entry and the plan\'s PNG target', () => {
    expect(builder<FrameBuilder>('frameRecipeOf')(cfr96(), { frameIndex: 48, pts: 1.92 }, INPUT)).toEqual({
      kind: 'frame', inputId: INPUT,
      entry: { kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(49, 25), rate: r(1) },
      target: { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' },
    });
  });

  it('TB02 a derived-empty frame becomes an empty entry in the plan\'s fill; a transparent plan keeps alpha', () => {
    const ledger = cfr96((plan) => {
      plan.policy!.emptyFill = 'transparent';
      const mapping = plan.originMapping as unknown as { entries: unknown[]; lastSource: { supportEnd: unknown } };
      mapping.entries = [{ kind: 'source', start: 0, count: 95, step: 1 }, { kind: 'derived-empty' }];
      mapping.lastSource.supportEnd = r(19, 5);
    });
    expect(builder<FrameBuilder>('frameRecipeOf')(ledger, { frameIndex: 95, pts: 3.8 }, INPUT)).toMatchObject({
      entry: { kind: 'empty', fill: 'transparent', window: { start: r(19, 5), end: r(96, 25) } }, target: { alpha: 'straight' },
    });
  });

  it('TB03 a 16-bit, HDR plan asks for a 16-bit tone-mapped PNG', () => {
    const ledger = cfr96((plan) => { plan.output = { toneMap: 'sdr-bt709', framePngBitDepth: 16 }; plan.source = { transfer: 'smpte2084', bitDepth: 10 }; });
    expect(builder<FrameBuilder>('frameRecipeOf')(ledger, { frameIndex: 0, pts: 0 }, INPUT)).toMatchObject({ target: { toneMap: 'sdr-bt709', pngBitDepth: 16 } });
  });

  it.each([['an ordinal past the last frame', { frameIndex: 96, pts: 3.84 }], ['a pts that is not the frame\'s', { frameIndex: 48, pts: 1.9 }]])('TB04 refuses %s', (_name, selection) => {
    expect(() => builder<FrameBuilder>('frameRecipeOf')(cfr96(), selection, INPUT)).toThrow(RangeError);
  });
});

describe('the segment recipe from the full ledger (§92 D4-4; design §7.17 segment row, §4.3 奇数行)', () => {
  it('TB05 a range of whole frames becomes one segment over its window: entries, the H.264 target, the frozen encode and the interval audio', () => {
    const segments = builder<SegmentBuilder>('segmentRecipesOf')(cfr96(), { range: { start: 1.92, end: 3.84 } }, INPUT, CARRIER);
    expect(segments).toEqual([{
      kind: 'segment', inputId: INPUT, window: { start: 48, end: 96 }, timescale: 25,
      entries: [{ kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(96, 25), rate: r(1) }],
      target: { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium', format: 'mp4-h264' },
      audio: { start: r(48, 25), end: r(96, 25), origin: r(0), spans: (read('cfr96').plan as { audioSpans: unknown }).audioSpans },
    }]);
  });

  it.each([
    ['an odd opaque display rounds down to even', { width: 161, height: 97 }, 'black', { width: 160, height: 96, format: 'mp4-h264', alpha: 'none' }],
    ['a one-pixel side becomes two', { width: 1, height: 97 }, 'black', { width: 2, height: 96, format: 'mp4-h264', alpha: 'none' }],
    ['a transparent display keeps its odd size in VP9 WebM', { width: 161, height: 97 }, 'transparent', { width: 161, height: 97, format: 'webm-vp9', alpha: 'straight' }],
  ] as const)('TB06 %s (§4.3 奇数行)', (_name, display, fill, expected) => {
    const ledger = cfr96((plan) => { Object.assign(plan.display!, display); plan.policy!.emptyFill = fill; });
    expect(builder<SegmentBuilder>('segmentRecipesOf')(ledger, { range: { start: 0, end: 1.92 } }, INPUT, CARRIER)[0]!.target).toMatchObject(expected);
  });

  it('TB07 a range that does not start on a frame boundary is refused', () => {
    expect(() => builder<SegmentBuilder>('segmentRecipesOf')(cfr96(), { range: { start: 0.01, end: 1.92 } }, INPUT, CARRIER)).toThrow(RangeError);
  });
});
