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
// The chunk windows come from the shared §5.4 planner with the run's frozen parameters; the builder takes them as given.
type SegmentBuilder = (ledger: unknown, selection: { range: { start: number; end: number } }, inputId: string, carrier: typeof CARRIER, windows: { start: number; end: number }[]) => Record<string, unknown>[];

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
    const segments = builder<SegmentBuilder>('segmentRecipesOf')(cfr96(), { range: { start: 1.92, end: 3.84 } }, INPUT, CARRIER, [{ start: 48, end: 96 }]);
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
    expect(builder<SegmentBuilder>('segmentRecipesOf')(ledger, { range: { start: 0, end: 1.92 } }, INPUT, CARRIER, [{ start: 0, end: 48 }])[0]!.target).toMatchObject(expected);
  });

  it('TB07 a range that does not start on a frame boundary is refused', () => {
    expect(() => builder<SegmentBuilder>('segmentRecipesOf')(cfr96(), { range: { start: 0.01, end: 1.92 } }, INPUT, CARRIER, [{ start: 0, end: 48 }])).toThrow(RangeError);
  });

  it('TB08 a range planned as two windows gives two chunk_encode recipes with the segment target and a stitch over them (§5.4)', () => {
    const target = { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium', format: 'mp4-h264' };
    const spans = (read('cfr96').plan as { audioSpans: unknown }).audioSpans;
    expect(builder<SegmentBuilder>('segmentRecipesOf')(cfr96(), { range: { start: 0, end: 3.84 } }, INPUT, CARRIER, [{ start: 0, end: 48 }, { start: 48, end: 96 }])).toEqual([
      { kind: 'chunk_encode', inputId: INPUT, window: { start: 0, end: 48 }, timescale: 25, target,
        entries: [{ kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(48, 25), rate: r(1) }] },
      { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 96 }, timescale: 25, target,
        entries: [{ kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(96, 25), rate: r(1) }] },
      { kind: 'stitch', inputId: INPUT, chunks: [{ inputId: recipes.chunkInputId(0), duration: r(48, 25) }, { inputId: recipes.chunkInputId(1), duration: r(48, 25) }],
        audio: { start: r(0), end: r(96, 25), origin: r(0), spans }, target },
    ]);
  });

  it.each([
    ['windows that leave a gap', [{ start: 0, end: 40 }, { start: 48, end: 96 }]],
    ['windows that are not the range\'s frames', [{ start: 0, end: 48 }]],
  ])('TB09 refuses %s', (_name, windows) => {
    expect(() => builder<SegmentBuilder>('segmentRecipesOf')(cfr96(), { range: { start: 0, end: 3.84 } }, INPUT, CARRIER, windows)).toThrow(RangeError);
  });
});

// S6d D4-5 and the people-analysis crop (§92; design §7.17 people and scene_cuts rows, 「唯一写点：worker的配方构造」): the
// anchor and the scanned range become D3-style entries from the frozen ledger; scene cuts come back as presentation
// ordinals and the worker's result assembly checks them against the table. Every span starts on a keyframe (0 or 48).
describe('people, candidate crops and scene cuts from the full ledger (§92 D4-5)', () => {
  type PeopleBuilder = (ledger: unknown, anchor: { frameIndex: number; pts: number }, inputId: string, profile: string) => Record<string, unknown>;
  type CropBuilder = (ledger: unknown, anchor: { frameIndex: number; pts: number }, inputId: string, crop: Record<string, unknown>) => Record<string, unknown>;
  type ScenesBuilder = (ledger: unknown, range: { start: number; end: number }, inputId: string, profile: string) => Record<string, unknown>;
  type ScenesResult = (ledger: unknown, window: { start: number; end: number }, cuts: number[]) => { frameIndex: number; pts: number }[];
  const ENTRY48 = { kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(49, 25), rate: r(1) };
  const PNG = { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };

  it('PB01 the people anchor is the frame\'s entry with the upright display target', () => {
    expect(builder<PeopleBuilder>('peopleRecipeOf')(cfr96(), { frameIndex: 48, pts: 1.92 }, INPUT, 'standard')).toEqual({ kind: 'people', inputId: INPUT, entry: ENTRY48, target: PNG, profile: 'standard' });
  });

  it('PB02 a candidate crop is the anchor\'s frame recipe with the display crop (run-container-analysis.ts candidate crops)', () => {
    const crop = { sourceWidth: 320, sourceHeight: 180, rect: { x: 10, y: 20, width: 100, height: 80 } };
    expect(builder<CropBuilder>('candidateCropRecipeOf')(cfr96(), { frameIndex: 48, pts: 1.92 }, INPUT, crop)).toEqual({ kind: 'frame', inputId: INPUT, entry: ENTRY48, target: PNG, crop });
  });

  it('PB03 an anchor on a derived-empty frame carries its empty entry (detection runs on the composed frame)', () => {
    const ledger = cfr96((plan) => {
      const mapping = plan.originMapping as unknown as { entries: unknown[]; lastSource: { supportEnd: unknown } };
      mapping.entries = [{ kind: 'source', start: 0, count: 95, step: 1 }, { kind: 'derived-empty' }];
      mapping.lastSource.supportEnd = r(19, 5);
    });
    expect(builder<PeopleBuilder>('peopleRecipeOf')(ledger, { frameIndex: 95, pts: 3.8 }, INPUT, 'standard')).toMatchObject({ entry: { kind: 'empty', fill: 'black', window: { start: r(19, 5), end: r(96, 25) } } });
  });

  it('PB04 a scanned range becomes its entries, each with its presentation-ordinal offset, without an inspect step', () => {
    expect(builder<ScenesBuilder>('sceneCutsRecipeOf')(cfr96(), { start: 1.92, end: 3.84 }, INPUT, 'standard')).toEqual({
      kind: 'scene_cuts', inputId: INPUT, window: { start: 48, end: 96 }, timescale: 25, profile: 'standard',
      entries: [{ kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(96, 25), rate: r(1), ordinalOffset: 48 }],
      target: { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none' },
    });
  });

  it('PB05 the result assembly maps cut ordinals to the table\'s display times and refuses one outside the window', () => {
    const result = builder<ScenesResult>('sceneCutsResultOf');
    expect(result(cfr96(), { start: 48, end: 96 }, [60, 72])).toEqual([{ frameIndex: 60, pts: 2.4 }, { frameIndex: 72, pts: 2.88 }]);
    expect(() => result(cfr96(), { start: 48, end: 96 }, [40])).toThrow(RangeError);
  });
});


// §93 D6-1 (frames-split design §7.17 时间线 row and 抽帧解码 row, §3.2 item 7; evidence
// engineering/demo/2026-11-05-1306-decode-start-overshoot/overshoot.sh): each span decodes from the latest source keyframe whose
// pts is not after its first frame (presented or not), and decodeStart = that keyframe's dts − min(0, firstPacketDts). The
// three ledgers are the evidence samples' timelines as the probe reads them with the edit list ignored: 25 fps frames,
// presented from the first one. bf2 and idr (B-frames) start at pts 2/25 with dts 0; neg (negative CTS offsets) starts at
// pts 0 with first packet dts −1/25.
describe('decodeStart from the selected source keyframe (§93 D6-1; design §7.17)', () => {
  type Keyframe = { pts: Exact; dts: Exact };
  /**
   * A 50-frame ledger of one sample: presentation ticks 1/25, source pts from `first` (in 1/25 s), the keyframes given.
   * @param first - The first frame's source pts in 1/25 s.
   * @param ordinals - The presented ordinals of the keyframes.
   * @param keyframes - Every source keyframe.
   * @param firstPacketDts - The first packet's dts.
   * @returns The ledger.
   */
  function sample(first: number, ordinals: number[], keyframes: Keyframe[], firstPacketDts: Exact): Record<string, unknown> {
    const ledger = cfr96((plan) => {
      plan.display = { ...plan.display, duration: r(2) };
      plan.presentation = { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 50, step: 1, duration: 1 }] };
      plan.originMapping = { ...plan.originMapping, timeBase: r(1, 25), origin: r(first, 25), entries: [{ kind: 'source', start: first, count: 50, step: 1 }],
        firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(2), hold: null } };
      plan.videoSpans = null as never;
    });
    ledger.encoding = { keyframeOrdinals: ordinals, codedWidth: 320, codedHeight: 180, sourceKeyframes: keyframes, firstPacketDts };
    return ledger;
  }
  // Times are reduced, as the recipe and the ledger schema write them (E07 refuses unreduced ones).
  const at = (n: number): Exact => {
    let [a, b] = [Math.abs(n), 25]; while (b !== 0) [a, b] = [b, a % b];
    const g = a === 0 ? 25 : a;
    return r(n / g, 25 / g);
  };
  const windows = recipes as unknown as { windowEntries: (ledger: unknown, window: { start: number; end: number }) => Record<string, unknown>[] };
  // bf2.mp4: g=10, bf=2: keyframes at pts 2/25, 12/25, 22/25 with dts 0, 10/25, 20/25.
  const BF2 = sample(2, [0, 10, 20], [{ pts: at(2), dts: at(0) }, { pts: at(12), dts: at(10) }, { pts: at(22), dts: at(20) }], at(0));
  // idr.mp4: adjacent IDRs at frames 10 and 11: pts 12/25 and 13/25, dts 10/25 and 11/25.
  const IDR = sample(2, [0, 10, 11], [{ pts: at(2), dts: at(0) }, { pts: at(12), dts: at(10) }, { pts: at(13), dts: at(11) }], at(0));
  // neg.mp4: negative CTS offsets: keyframes at pts 0, 10/25, 20/25 with dts −1/25, 9/25, 19/25; first packet dts −1/25.
  const NEG = sample(0, [0, 10, 20], [{ pts: at(0), dts: at(-1) }, { pts: at(10), dts: at(9) }, { pts: at(20), dts: at(19) }], at(-1));

  it.each([
    ['bf2: a target at the end of a GOP (source 18/25) decodes from the keyframe at 12/25, dts 10/25', BF2, 16, at(10), at(18)],
    ['bf2: a target that is itself a keyframe decodes from that keyframe\'s dts, not its pts', BF2, 10, at(10), at(12)],
    ['idr: the first of two adjacent IDRs (12/25) decodes from its own dts 10/25, before the next IDR', IDR, 10, at(10), at(12)],
    ['idr: the second IDR (13/25) decodes from its own dts 11/25', IDR, 11, at(11), at(13)],
    ['neg: a target before the second keyframe (9/25) decodes from the first, dts −1/25 shifted to 0', NEG, 9, r(0), at(9)],
    ['neg: the second keyframe (10/25) decodes from dts 9/25 + 1/25 = 10/25', NEG, 10, at(10), at(10)],
  ] as const)('KD01 %s', (_name, ledger, first, decodeStart, clipStart) => {
    expect(windows.windowEntries(ledger, { start: first, end: first + 2 })).toEqual([
      { kind: 'source', decodeStart, clipStart, displayStart: at(first), displayEnd: at(first + 2), rate: r(1) },
    ]);
  });

  it('KD02 a frame recipe on a mid-GOP frame carries the same decodeStart', () => {
    expect(builder<FrameBuilder>('frameRecipeOf')(BF2, { frameIndex: 16, pts: 0.64 }, INPUT)).toMatchObject({ entry: { decodeStart: at(10), clipStart: at(18) } });
  });
});

describe('edits that start the picture late (§7.17 timeline row; design §4.2.1 开头行)', () => {
  const windows = recipes as unknown as { windowEntries: (ledger: unknown, window: { start: number; end: number }, from?: Exact) => Record<string, unknown>[] };
  /**
   * A 50-frame 25 fps ledger on a 1/50 display clock, with the plan's mapping and edits given.
   * @param plan - The presentation table, origin mapping and edits.
   * @param keyframe - The one source keyframe.
   * @returns The ledger.
   */
  function late(plan: { presentation: unknown; origin: Exact; entries: readonly unknown[]; timeBase: Exact; lead: Exact | null; spans: unknown; supportEnd?: Exact }, keyframe: Exact): Record<string, unknown> {
    const ledger = cfr96((edited) => {
      edited.presentation = plan.presentation as never;
      edited.originMapping = { ...edited.originMapping, timeBase: plan.timeBase, origin: plan.origin, entries: plan.entries,
        firstSource: { supportStart: r(3, 10), lead: plan.lead === null ? null : { kind: 'derived-lead', start: plan.lead } },
        lastSource: { support: 'declared', supportEnd: plan.supportEnd ?? r(23, 10), hold: null } };
      edited.videoSpans = plan.spans as never;
    });
    ledger.encoding = { keyframeOrdinals: [0], codedWidth: 320, codedHeight: 180, sourceKeyframes: [{ pts: keyframe, dts: keyframe }], firstPacketDts: keyframe };
    return ledger;
  }
  const EVEN = { schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 50, step: 2, duration: 2 }] };
  // Frame 0 is held from 0 to where frame 1 starts, 0.34 s: the 0.3 s lead plus its own 0.04 s.
  const LEAD = { schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 1, step: 1, duration: 17 }, { start: 17, count: 49, step: 2, duration: 2 }] };

  it('LV01 a leading empty edit kept in the plan maps presentation 0 to the media start, not the origin past it', () => {
    // empty-edit.mp4: 250 ms empty edit, then media 0 to 2 s; origin 1/4 and the edit rebased onto it.
    const ledger = late({ presentation: EVEN, origin: r(1, 4), entries: [{ kind: 'source', start: 0, count: 50, step: 1 }], timeBase: r(1, 25), lead: null,
      spans: [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(0), rate: r(1) }] }, r(0));
    expect(windows.windowEntries(ledger, { start: 0, end: 2 })).toEqual([{ kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(2, 25), rate: r(1) }]);
  });

  it.each([
    // latevid.mp4: a 0.3 s empty edit before media 0, with audio from 0.
    ['an empty edit before the media', { origin: r(0), entries: [{ kind: 'source', start: 0, count: 50, step: 1 }], timeBase: r(1, 25),
      spans: [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(3, 10), rate: r(1) }] }, r(0)],
    // The same picture without an edit list: media starts at 0.3 s, audio at 0.
    ['no edit list, the media starting at 0.3 s', { origin: r(0), entries: [{ kind: 'source', start: 15, count: 50, step: 2 }], timeBase: r(1, 50), spans: null }, r(3, 10)],
  ] as const)('LV02 %s: the held first frame is its own entry from its own pts at rate 1/n, n = ceil(lead / frame), so no later frame is trimmed in', (_name, plan, start) => {
    const ledger = late({ presentation: LEAD, lead: r(0), ...plan }, start);
    const next = { numerator: String(BigInt(start.numerator) * 25n + BigInt(start.denominator)), denominator: String(BigInt(start.denominator) * 25n) };
    const reduced = (value: Exact): Exact => {
      let [a, b] = [BigInt(value.numerator), BigInt(value.denominator)]; while (b !== 0n) [a, b] = [b, a % b];
      return { numerator: String(BigInt(value.numerator) / a), denominator: String(BigInt(value.denominator) / a) };
    };
    expect(windows.windowEntries(ledger, { start: 0, end: 3 })).toEqual([
      // The lead shows 17/50 s of one 1/25 s frame: n = ceil(8.5) = 9.
      { kind: 'source', decodeStart: start, clipStart: start, displayStart: r(0), displayEnd: r(17, 50), rate: r(1, 9) },
      { kind: 'source', decodeStart: start, clipStart: reduced(next), displayStart: r(17, 50), displayEnd: r(21, 50), rate: r(1) },
    ]);
  });

  it('LV03 a window starting inside the lead still shows the held frame from its own pts', () => {
    const ledger = late({ presentation: LEAD, lead: r(0), origin: r(0), entries: [{ kind: 'source', start: 0, count: 50, step: 1 }], timeBase: r(1, 25),
      spans: [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(3, 10), rate: r(1) }] }, r(0));
    expect(windows.windowEntries(ledger, { start: 0, end: 1 }, r(1, 10))).toEqual([
      { kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(1, 10), displayEnd: r(17, 50), rate: r(1, 9) },
    ]);
  });

  it('LV04 a lone held frame fits its own source length, not the rest of the media', () => {
    // The frame shows itself from 3/10 to 17/50 (its support end), 1/25 s, after a 0.3 s lead.
    const ledger = late({ presentation: { schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 1, step: 1, duration: 17 }] }, lead: r(0), origin: r(0),
      entries: [{ kind: 'source', start: 15, count: 1, step: 1 }], timeBase: r(1, 50), spans: null, supportEnd: r(17, 50) }, r(3, 10));
    expect(windows.windowEntries(ledger, { start: 0, end: 1 })).toEqual([
      { kind: 'source', decodeStart: r(3, 10), clipStart: r(3, 10), displayStart: r(0), displayEnd: r(17, 50), rate: r(1, 9) },
    ]);
  });

  it('LV05 a 29.97 fps lead on 1/90000 started mid-lead keeps a rate of numerator 1 and the frame\'s own pts, so the chunk clock stays small', () => {
    // A 0.3 s empty edit before 30000/1001 fps media: the lead shows [0, 10001/30000) of one 1001/30000 s frame, n = ceil(9.99) = 10.
    const NTSC = { schemaVersion: 1, timescale: 30000, runs: [{ start: 0, count: 1, step: 1, duration: 10001 }, { start: 10001, count: 49, step: 1001, duration: 1001 }] };
    const ledger = late({ presentation: NTSC, lead: r(0), origin: r(0), entries: [{ kind: 'source', start: 0, count: 50, step: 3003 }], timeBase: r(1, 90000),
      spans: [{ sourceStart: r(0), sourceEnd: r(1001, 600), presentationStart: r(3, 10), rate: r(1) }] }, r(0));
    expect(windows.windowEntries(ledger, { start: 0, end: 1 }, r(3, 25))).toEqual([
      { kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(3, 25), displayEnd: r(10001, 30000), rate: r(1, 10) },
    ]);
  });
});

describe('a plan without edits whose media starts after the origin (§7.17 timeline row)', () => {
  const windows = recipes as unknown as { windowEntries: (ledger: unknown, window: { start: number; end: number }, from?: Exact) => Record<string, unknown>[] };
  it('LV06 a window starting inside a frame shows that frame from the same point of its own source time', () => {
    // An ffmpeg x265 MP4 at 25 fps: its whole-media edit collapses, origin 0, and its frames' media pts start at 1024/12800 (2/25 s).
    const ledger = cfr96((plan) => {
      plan.presentation = { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 25, step: 1, duration: 1 }] };
      plan.originMapping = { ...plan.originMapping, timeBase: r(1, 12800), origin: r(0), entries: [{ kind: 'source', start: 1024, count: 25, step: 512 }],
        firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(1), hold: null } };
      plan.videoSpans = null as never;
    });
    ledger.encoding = { keyframeOrdinals: [0], codedWidth: 320, codedHeight: 180, sourceKeyframes: [{ pts: r(2, 25), dts: r(2, 25) }], firstPacketDts: r(2, 25) };
    // 8/15 s is 1/75 s into frame 13 (13/25 s), whose media pts is 3/5: the window shows it from 3/5 + 1/75 = 46/75.
    expect(windows.windowEntries(ledger, { start: 13, end: 20 }, r(8, 15))).toEqual([
      { kind: 'source', decodeStart: r(2, 25), clipStart: r(46, 75), displayStart: r(8, 15), displayEnd: r(4, 5), rate: r(1) },
    ]);
  });
});
