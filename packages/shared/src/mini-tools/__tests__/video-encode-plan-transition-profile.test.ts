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
const api = miniTools as unknown as { transitionOutputProfile: (first: Plan, second: Plan, config: unknown) => Profile; presentationOutputFps: (table: Table) => Rational };
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
    // Averages of 2000/847 and 3/2 fps are below the lowest standard rate.
    expect(same(api.presentationOutputFps(vfrPlan().presentation as Table), r(12))).toBe(true);
    expect(same(api.presentationOutputFps(transparentPlan().presentation as Table), r(12))).toBe(true);
  });

  it("FPS03 a single-frame table takes the standard rate nearest one frame over its duration", () => {
    expect(same(api.presentationOutputFps({ schemaVersion: 1, timescale: 1000, runs: [{ start: 0, count: 1, step: 5000, duration: 5000 }] }), r(12))).toBe(true);
  });

  // A first frame of `first` ticks, then `frames − 1` frames `step` ticks apart: two spacings, so the table is VFR.
  it.each([
    ["30000/991 (a 1/1000 clock of 33 and 34 ms frames)", 1000, 30, 34, 33, r(30)],
    ["9000000/301980 ≈ 29.80 (a phone clip on 1/90000)", 90000, 100, 3000, 3020, r(30000, 1001)],
    ["9000000/375940 ≈ 23.94", 90000, 100, 3700, 3760, r(24000, 1001)],
    ["10000/410 ≈ 24.39", 1000, 10, 50, 40, r(24)],
    ["9000000/150297 ≈ 59.88", 90000, 100, 1500, 1503, r(60000, 1001)],
    ["10000/745 ≈ 13.42", 1000, 10, 70, 75, r(12)],
    ["9000000/44950 ≈ 200.2, above the highest", 90000, 100, 400, 450, r(120)],
  ] as const)("FPS04 a VFR average of %s takes the nearest standard rate", (_name, timescale, frames, first, step, expected) => {
    const table: Table = { schemaVersion: 1, timescale, runs: [{ start: 0, count: 1, step: first, duration: first }, { start: first, count: frames - 1, step, duration: step }] };
    const fps = api.presentationOutputFps(table);
    expect(fps, JSON.stringify(fps)).toEqual(expected);
  });
});
