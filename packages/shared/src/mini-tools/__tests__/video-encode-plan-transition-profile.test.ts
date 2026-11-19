// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 frames-split §7.17 转场输出档 row: `transitionOutputProfile(first, second, config)` in shared
 * `video-encode-plan.ts` takes each clip's selected P (display size, grid fps, transparency), in timeline order: width and
 * height from the first clip's display, odd sides of an opaque output taken down to even (1 up to 2, §4.3), a transparent
 * output keeping them; fps is the first clip's grid fps (every clip is a fixed-rate grid, so no rate is measured from a
 * frame table any more); alpha when either clip is transparent; codec vp9 with alpha, else h264; `timeBase` is the inverse
 * of `fps`; `pixFmt` is `yuv420p` opaque and `yuva420p` with alpha; `color` is the SDR BT.709 constant; the config supplies
 * only `encode: { crf, preset }`. The table-rate and conform-grid cases are deleted with the frame table (§3.4).
 */
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type Rational = { numerator: number; denominator: number };
type Clip = { display: { width: number; height: number; fps: Rational }; alpha: boolean };
interface Profile { width: number; height: number; fps: Rational; timeBase: Rational; alpha: boolean; codec: string; encode: unknown; pixFmt: string; color: unknown }
const api = miniTools as unknown as { transitionFitRect: (display: { width: number; height: number }, output: { width: number; height: number }) => { x: number; y: number; width: number; height: number }; transitionOutputProfile: (first: Clip, second: Clip, config: unknown) => Profile };
const r = (numerator: number, denominator = 1): Rational => ({ numerator, denominator });
const CONFIG = { encode: { crf: 18, preset: "medium" } };
const BT709 = { matrix: "bt709", range: "tv", primaries: "bt709", transfer: "bt709" };

/**
 * An opaque 8 fps clip.
 * @param width - Display width.
 * @param height - Display height.
 * @returns The clip.
 */
const cfrPlan = (width = 64, height = 48): Clip => ({ display: { width, height, fps: r(8) }, alpha: false });
/**
 * An opaque 29.97 fps clip.
 * @returns The clip.
 */
const ntscPlan = (): Clip => ({ display: { width: 320, height: 240, fps: r(30000, 1001) }, alpha: false });
/**
 * A transparent 3/2 fps clip.
 * @param width - Display width.
 * @returns The clip.
 */
const transparentPlan = (width = 96): Clip => ({ display: { width, height: 64, fps: r(3, 2) }, alpha: true });

describe("the transition output profile (§97 D13-1; frames-split §7.17)", () => {
  it("TP01 takes the first clip's display size and grid fps, opaque H.264 with the configured encode and pixel format", () => {
    const profile = api.transitionOutputProfile(cfrPlan(), ntscPlan(), CONFIG);
    expect(profile).toMatchObject({ width: 64, height: 48, alpha: false, codec: "h264", encode: CONFIG.encode, pixFmt: "yuv420p", color: BT709 });
    expect(profile.fps).toEqual(r(8));
    expect(profile.timeBase).toEqual(r(1, 8));
  });

  it("TP02 an NTSC first clip keeps its exact grid fps", () => {
    const profile = api.transitionOutputProfile(ntscPlan(), cfrPlan(), CONFIG);
    expect(profile).toMatchObject({ width: 320, height: 240, alpha: false, codec: "h264", pixFmt: "yuv420p" });
    expect(profile.fps).toEqual(r(30000, 1001));
    expect(profile.timeBase).toEqual(r(1001, 30000));
  });

  it.each([
    ["the first", (): [Clip, Clip] => [transparentPlan(), cfrPlan()], 96, 64],
    ["the second", (): [Clip, Clip] => [cfrPlan(), transparentPlan()], 64, 48],
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

describe("where a clip sits on the transition frame (frames-split §7.17; the preview's contain)", () => {
  it.each([
    ["a portrait phone clip on a landscape frame", { width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { x: 656, y: 0, width: 608, height: 1080 }],
    ["a 4:3 clip on a 16:9 frame", { width: 640, height: 480 }, { width: 1920, height: 1080 }, { x: 240, y: 0, width: 1440, height: 1080 }],
    ["a wider clip letterboxed", { width: 1920, height: 800 }, { width: 1280, height: 720 }, { x: 0, y: 93, width: 1280, height: 533 }],
    ["the same shape fills the frame", { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }],
  ])("FIT01 %s", (_name, display, output, rect) => {
    expect(api.transitionFitRect(display, output)).toEqual(rect);
  });
});
