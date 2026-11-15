// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 item 2 (frames-split §7.17 转场输出档 row; D12-2, D13-1): `transitionOutputProfile(first, second,
 * config)` in shared `video-encode-plan.ts` takes each clip's selected full `VideoPresentationPlan`, in timeline order:
 * width and height from the first plan's display, odd sides of an opaque output taken down to even (1 up to 2, §4.3 and the
 * D05 row), a transparent output keeping them; fps from the first plan's presentation, timescale ÷ frame duration when CFR,
 * else the standard rate nearest frame count ÷ display duration, as an exact rational; alpha when either plan's `policy.emptyFill` is transparent;
 * codec vp9 with alpha, else h264. §97 D15-5: `timeBase` is the inverse of `fps`; `pixFmt` is derived, `yuv420p` opaque and
 * `yuva420p` with alpha; `color` is the SDR BT.709 constant; the config supplies only `encode: { crf, preset }` (the
 * presentation crf and preset). Read from the mini-tools entry by name so this compiles before the function exists.
 */
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";
import { projectPresentationTable } from "@shared/mini-tools/video-presentation-table.js";

type Rational = { numerator: string; denominator: string };
type Plan = Record<string, unknown> & { display: { width: number; height: number; duration: Rational }; policy: { singleFrameDurationMs: number; emptyFill: "black" | "transparent" } };
interface Profile { width: number; height: number; fps: Rational; timeBase: Rational; alpha: boolean; codec: string; encode: unknown; pixFmt: string; color: unknown }
type Table = { schemaVersion: 1; timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
const api = miniTools as unknown as { transitionOutputProfile: (first: Plan, second: Plan, config: unknown) => Profile; presentationOutputFps: (table: Table) => Rational; presentationConform: (table: Table) => { origin: Rational; period: Rational } | null; conformedTime: (conform: { origin: Rational; period: Rational }, at: readonly [bigint, bigint]) => [bigint, bigint] };
const r = (numerator: number, denominator = 1): Rational => ({ numerator: String(numerator), denominator: String(denominator) });
const CONFIG = { encode: { crf: 18, preset: "medium" } };
const BT709 = { matrix: "bt709", range: "tv", primaries: "bt709", transfer: "bt709" };

/**
 * Whether two rationals are the same number, without assuming either is reduced.
 * @param a - One rational.
 * @param b - The other.
 * @returns Whether they are equal.
 */
function same(a: Rational, b: Rational): boolean {
  return BigInt(a.numerator) * BigInt(b.denominator) === BigInt(b.numerator) * BigInt(a.denominator);
}

/**
 * CFR 17 frames at 8 fps, opaque (the version test's `cfrPlan`).
 * @param width - Display width.
 * @param height - Display height.
 * @returns A valid plan.
 */
function cfrPlan(width = 64, height = 48): Plan {
  return {
    display: { width, height, duration: r(17, 8) }, colorMatrix: "bt601", source: { transfer: null, bitDepth: 8 }, output: { toneMap: "none", framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: "black" },
    presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
    originMapping: {
      timeBase: r(1, 16384), origin: r(0), entries: [{ kind: "source", start: 4096, count: 17, step: 2048 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: "declared", supportEnd: r(17, 8), hold: null },
    },
    videoSpans: [{ sourceStart: r(1, 4), sourceEnd: r(19, 8), presentationStart: r(0), rate: r(1) }],
    audioSpans: [{ sourceStart: r(8, 375), sourceEnd: r(6439, 3000), presentationStart: r(0), rate: r(1) }],
    segmentDuration: null,
  };
}

/**
 * VFR: four frames over 847/500 s (the version test's `matroskaPlan`), opaque; average 2000/847 fps.
 * @returns A valid plan.
 */
function vfrPlan(): Plan {
  return {
    display: { width: 320, height: 240, duration: r(847, 500) }, colorMatrix: "bt601", source: { transfer: null, bitDepth: 8 }, output: { toneMap: "none", framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: "black" },
    presentation: projectPresentationTable([
      { displayStart: r(0), displayEnd: r(7, 100) }, { displayStart: r(7, 100), displayEnd: r(17, 100) },
      { displayStart: r(17, 100), displayEnd: r(233, 250) }, { displayStart: r(233, 250), displayEnd: r(847, 500) },
    ]),
    originMapping: {
      timeBase: r(1, 1000), origin: r(0), entries: [{ kind: "source", start: 0, count: 2, step: 70 }, { kind: "source", start: 170, count: 2, step: 762 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: "previous-max", supportEnd: r(847, 500), hold: null },
    },
    videoSpans: null, audioSpans: null, segmentDuration: r(932267, 1_000_000),
  };
}

/**
 * Transparent, three frames over 2 s (the version test's `gapHoldPlan`); average 3/2 fps.
 * @param width - Display width.
 * @returns A valid plan.
 */
function transparentPlan(width = 96): Plan {
  return {
    display: { width, height: 64, duration: r(2) }, colorMatrix: "bt709", source: { transfer: "bt709", bitDepth: 8 }, output: { toneMap: "none", framePngBitDepth: 8 },
    policy: { singleFrameDurationMs: 5000, emptyFill: "transparent" },
    presentation: { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 1, step: 2, duration: 2 }, { start: 2, count: 1, step: 1, duration: 1 }, { start: 3, count: 1, step: 5, duration: 5 }] },
    originMapping: {
      timeBase: r(1, 1024), origin: r(0),
      entries: [{ kind: "source", start: 0, count: 1, step: 0 }, { kind: "derived-empty" }, { kind: "source", start: 512, count: 1, step: 0 }],
      firstSource: { supportStart: r(1, 4), lead: { kind: "derived-lead", start: r(0) } },
      lastSource: { support: "declared", supportEnd: r(1), hold: { kind: "derived-hold", end: r(2) } },
    },
    videoSpans: [{ sourceStart: r(0), sourceEnd: r(1, 4), presentationStart: r(1, 4), rate: r(1) }, { sourceStart: r(1, 2), sourceEnd: r(3, 4), presentationStart: r(3, 4), rate: r(1) }],
    audioSpans: [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(0), rate: r(1) }],
    segmentDuration: null,
  };
}

describe("the transition output profile (§97 D13-1; frames-split §7.17)", () => {
  it("TP01 takes the first clip's display size and CFR frame rate, opaque H.264 with the configured encode and pixel format", () => {
    const profile = api.transitionOutputProfile(cfrPlan(), vfrPlan(), CONFIG);
    expect(profile).toMatchObject({ width: 64, height: 48, alpha: false, codec: "h264", encode: CONFIG.encode, pixFmt: "yuv420p", color: BT709 });
    expect(same(profile.fps, r(8))).toBe(true);
    expect(same(profile.timeBase, r(1, 8))).toBe(true);
  });

  it("TP02 a VFR first clip gives the standard frame rate nearest its average: 2000/847 fps gives 12", () => {
    const profile = api.transitionOutputProfile(vfrPlan(), cfrPlan(), CONFIG);
    expect(profile).toMatchObject({ width: 320, height: 240, alpha: false, codec: "h264", pixFmt: "yuv420p" });
    expect(same(profile.fps, r(12))).toBe(true);
    expect(same(profile.timeBase, r(1, 12))).toBe(true);
  });

  it.each([
    ["the first", (): [Plan, Plan] => [transparentPlan(), cfrPlan()], 96, 64],
    ["the second", (): [Plan, Plan] => [cfrPlan(), transparentPlan()], 64, 48],
  ] as const)("TP03 is transparent VP9 when %s clip is transparent", (_name, plans, width, height) => {
    const [first, second] = plans();
    expect(api.transitionOutputProfile(first, second, CONFIG)).toMatchObject({ width, height, alpha: true, codec: "vp9", pixFmt: "yuva420p", color: BT709, encode: CONFIG.encode });
  });

  it.each([
    ["odd sides go down to even", 65, 49, 64, 48],
    ["a one-pixel side goes up to two", 1, 48, 2, 48],
  ] as const)("TP04 an opaque output: %s", (_name, width, height, outWidth, outHeight) => {
    expect(api.transitionOutputProfile(cfrPlan(width, height), cfrPlan(), CONFIG)).toMatchObject({ width: outWidth, height: outHeight, alpha: false });
  });

  it("TP05 a transparent output keeps odd sides", () => {
    expect(api.transitionOutputProfile(transparentPlan(97), cfrPlan(), CONFIG)).toMatchObject({ width: 97, height: 64, alpha: true, codec: "vp9" });
  });
});

// frames-split §7.17 转场输出档 row: one rule for the output frame rate, which the profile, the panel and the timeline
// Dialog all read. A table tiles [0, display.duration) (§7.16), so a CFR clip whose last frame is cut short at the end of
// its stream still has one frame spacing.
describe("the output frame rate of a presentation table (frames-split §7.17)", () => {
  // 100 frames at 25 fps on a 1/100 s clock, the last one shown for 2 ticks instead of 4.
  const shortenedLast: Table = { schemaVersion: 1, timescale: 100, runs: [{ start: 0, count: 99, step: 4, duration: 4 }, { start: 396, count: 1, step: 2, duration: 2 }] };

  it("FPS01 a CFR table whose last run is a shortened single frame keeps its frame rate", () => {
    expect(same(api.presentationOutputFps(shortenedLast), r(25))).toBe(true);
    const plan = { ...cfrPlan(), display: { width: 64, height: 48, duration: r(398, 100) }, presentation: shortenedLast };
    expect(same(api.transitionOutputProfile(plan, cfrPlan(), CONFIG).fps, r(25))).toBe(true);
  });

  it("FPS02 a table with uneven frame spacing takes the standard rate nearest its frames over its duration", () => {
    // From its second frame on, 3 frames over 1.624 s: below the lowest standard rate.
    expect(same(api.presentationOutputFps(vfrPlan().presentation as Table), r(12))).toBe(true);
  });

  it("FPS05 the first frame's length does not count either: a CFR clip whose first frame is held as a lead keeps its rate", () => {
    // 25 fps on 1/50: frame 0 held over the 0.3 s lead plus its own 0.04 s, the last frame held 0.24 s for the audio.
    const led: Table = { schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 1, step: 17, duration: 17 }, { start: 17, count: 48, step: 2, duration: 2 }, { start: 113, count: 1, step: 12, duration: 12 }] };
    expect(api.presentationOutputFps(led)).toEqual(r(25));
    // Three frames, a derived lead, an empty frame and a hold: the one spacing left is 1/4 s.
    expect(api.presentationOutputFps(transparentPlan().presentation as Table)).toEqual(r(4));
  });

  it("FPS03 a single-frame table takes the standard rate nearest one frame over its duration", () => {
    expect(same(api.presentationOutputFps({ schemaVersion: 1, timescale: 1000, runs: [{ start: 0, count: 1, step: 5000, duration: 5000 }] }), r(12))).toBe(true);
  });

  it("FPS06 a VFR clip's average runs between frame starts, so a last frame held for longer audio does not lower it", () => {
    // A 30 fps WebM on a 1/1000 clock (frames at 0, 33, 67, 100 ms...), 2 s of picture, the last frame held to 3 s of audio.
    const starts = Array.from({ length: 60 }, (_unused, k) => Math.round((k * 1000) / 30));
    const runs = starts.map((start, k) => ({ start, count: 1, step: (starts[k + 1] ?? 3000) - start, duration: (starts[k + 1] ?? 3000) - start }));
    expect(api.presentationOutputFps({ schemaVersion: 1, timescale: 1000, runs })).toEqual(r(30));
  });

  it.each([
    ["two 10 fps frames", { schemaVersion: 1, timescale: 10, runs: [{ start: 0, count: 2, step: 1, duration: 1 }] }, r(10)],
    ["two 25 fps frames, the last held for longer audio", { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 1, step: 1, duration: 1 }, { start: 1, count: 1, step: 50, duration: 50 }] }, r(25)],
  ])("FPS07 %s keep the rate of their one spacing", (_name, table, expected) => {
    expect(api.presentationOutputFps(table as Table)).toEqual(expected);
  });

  it.each([["30", 30, r(30)], ["30000/1001", 30000 / 1001, r(30000, 1001)], ["24", 24, r(24)], ["24000/1001", 24000 / 1001, r(24000, 1001)], ["60000/1001", 60000 / 1001, r(60000, 1001)]] as const)(
    "FPS08 a 1 s WebM at %s fps, its starts rounded to 1 ms, is that rate", (_name, rate, expected) => {
      const count = Math.round(rate);
      const starts = Array.from({ length: count }, (_unused, k) => Math.round((k * 1000) / rate));
      const runs = starts.map((start, k) => ({ start, count: 1, step: (starts[k + 1] ?? 1000) - start, duration: (starts[k + 1] ?? 1000) - start }));
      expect(api.presentationOutputFps({ schemaVersion: 1, timescale: 1000, runs })).toEqual(expected);
    });

  // Frames `step` ticks apart with the second one lasting `odd` ticks: two spacings after the first frame, so the table is VFR.
  it.each([
    ["29000/958 (a 1/1000 clock of 33 and 34 ms frames)", 1000, 30, 34, 33, r(30)],
    ["8910000/298960 ≈ 29.80 (a phone clip on 1/90000)", 90000, 100, 3000, 3020, r(30000, 1001)],
    ["8910000/372180 ≈ 23.94", 90000, 100, 3700, 3760, r(24000, 1001)],
    ["8000/333 ≈ 24.02", 1000, 10, 53, 40, r(24)],
    ["8910000/148794 ≈ 59.88", 90000, 100, 1500, 1503, r(60000, 1001)],
    ["9000/670 ≈ 13.43", 1000, 10, 70, 75, r(12)],
    ["8910000/44500 ≈ 200.2, above the highest", 90000, 100, 400, 450, r(120)],
  ] as const)("FPS04 a VFR average of %s takes the nearest standard rate", (_name, timescale, frames, odd, step, expected) => {
    const table: Table = { schemaVersion: 1, timescale, runs: [{ start: 0, count: 1, step, duration: step }, { start: step, count: 1, step: odd, duration: odd },
      { start: step + odd, count: frames - 2, step, duration: step }] };
    const fps = api.presentationOutputFps(table);
    expect(fps, JSON.stringify(fps)).toEqual(expected);
  });
});

// frames-split §7.17 rounding clock row: a table whose clock rounded a constant rate's frame times has an exact grid.
describe("the conform grid of a presentation table (frames-split §7.17)", () => {
  /**
   * A table of CFR frames whose starts are rounded to a clock.
   * @param rate - The true rate as numerator and denominator.
   * @param timescale - The table's ticks per second.
   * @param granularity - The rounding clock in table ticks.
   * @param count - The frames.
   * @returns The table.
   */
  const rounded = (rate: readonly [number, number], timescale: number, granularity: number, count: number): Table => {
    const starts = Array.from({ length: count + 1 }, (_unused, k) => Math.round((k * rate[1] * timescale) / rate[0] / granularity) * granularity);
    return { schemaVersion: 1, timescale, runs: starts.slice(0, count).map((start, k) => ({ start, count: 1, step: starts[k + 1]! - start, duration: starts[k + 1]! - start })) };
  };
  it.each<[string, Table, Rational | null]>([
    ["a 30 fps WebM on its 1 ms clock", rounded([30, 1], 1000, 1, 60), r(1, 30)],
    ["a 29.97 fps WebM on its 1 ms clock", rounded([30000, 1001], 1000, 1, 60), r(1001, 30000)],
    ["a 59.94 fps MKV on its 1 ms clock", rounded([60000, 1001], 1000, 1, 120), r(1001, 60000)],
    ["a 29.97 fps iPhone clip on 1/600 in a 1/3000 table", rounded([30000, 1001], 3000, 5, 60), r(1001, 30000)],
    ["a 29.97 fps iPhone clip remuxed to 1/19200", rounded([30000, 1001], 19200, 32, 60), r(1001, 30000)],
    ["an exact 25 fps table on a 1/25 clock", { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 50, step: 1, duration: 1 }] }, null],
    ["a VFR table", vfrPlan().presentation as Table, null],
  ])("CF01 %s", (_name, table, period) => {
    const conform = api.presentationConform(table);
    expect(conform?.period ?? null).toEqual(period);
    // The grid passes through the first frame's start, 0.
    if (period !== null) expect(same(conform!.origin, period), JSON.stringify(conform)).toBe(true);
  });

  it("CF02 every stored start rounds to its own exact grid point, and so does the output rate", () => {
    const table = rounded([30000, 1001], 19200, 32, 300);
    const conform = api.presentationConform(table)!;
    table.runs.slice(1).forEach((run, k) => {
      const [numerator, denominator] = api.conformedTime(conform, [BigInt(run.start), 19200n]);
      // Frame k + 1 truly starts at (k + 1) · 1001/30000 s.
      expect(numerator * 30000n).toBe(BigInt(k + 1) * 1001n * denominator);
    });
    expect(api.presentationOutputFps(table)).toEqual(r(30000, 1001));
  });

  it("CF03 a picture that starts after a held first frame takes the grid through the middle of its offsets", () => {
    // A 30 fps WebM whose picture starts at 250 ms (the first frame held from 0): 250, 283, 317, 350... ms.
    const starts = [0, ...Array.from({ length: 61 }, (_unused, k) => Math.round(250 + (k * 1000) / 30))];
    const table: Table = { schemaVersion: 1, timescale: 1000, runs: starts.slice(0, 61).map((start, k) => ({ start, count: 1, step: starts[k + 1]! - start, duration: starts[k + 1]! - start })) };
    const conform = api.presentationConform(table)!;
    expect(conform.period).toEqual(r(1, 30));
    // The second frame's grid point is 250 ms within the clock's rounding: the offsets of 250 + k · 33.3 ms span ±1/3 ms.
    const [numerator, denominator] = [BigInt(conform.origin.numerator), BigInt(conform.origin.denominator)];
    expect(Number(numerator) / Number(denominator)).toBeCloseTo(0.25, 3);
    // Each later frame lands on its own grid point, 33.3 ms apart.
    const placed = table.runs.slice(1).map((run) => { const [n, d] = api.conformedTime(conform, [BigInt(run.start), 1000n]); return Number(n) / Number(d); });
    placed.forEach((at, k) => expect(at - placed[0]!).toBeCloseTo(k / 30, 12));
  });
});

