// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 item 3 (canvas design §4 转场行; frames-split §7.14, §7.17; D11-3, D12-2): a non-Cut transition
 * lasts between one output frame and half the shorter trimmed clip; `transitionDurationBounds` (shared `video-plan.ts`)
 * answers null when that half is under one frame. Read from the mini-tools entry by name so this compiles before it exists.
 */
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface Clip { clipId: string; inputId: string; in: number; out: number; transition: { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number } }
type Rational = { numerator: string; denominator: string };
const fps = (numerator: number, denominator = 1): Rational => ({ numerator: String(numerator), denominator: String(denominator) });
// D13-2: fps is the plan's exact rational; the bounds are plain seconds, as the draft's transition duration is.
type Bounds = (clips: readonly Clip[], fps: Rational) => { min: number; max: number } | null;
const api = miniTools as unknown as { transitionDurationBounds: Bounds; fitTransitions: (clips: readonly Clip[], fps: Rational | null) => Clip[] };
/**
 * A two-clip timeline with the given trimmed lengths.
 * @param first - The first clip's trimmed seconds.
 * @param second - The second clip's trimmed seconds.
 * @returns The clips.
 */
function clips(first: number, second: number): Clip[] {
  return [
    { clipId: "50000000-0000-4000-8000-000000000001", inputId: "60000000-0000-4000-8000-000000000001", in: 1, out: 1 + first, transition: { kind: "fade", duration: 0.5 } },
    { clipId: "50000000-0000-4000-8000-000000000002", inputId: "60000000-0000-4000-8000-000000000002", in: 0, out: second, transition: { kind: "cut", duration: 0 } },
  ];
}

describe("transition duration bounds (§97 D11-3; canvas design §4, frames-split §7.17)", () => {
  it("TR01 spans one output frame to half the shorter trimmed clip", () => {
    expect(api.transitionDurationBounds(clips(4, 3), fps(25))).toEqual({ min: 1 / 25, max: 1.5 });
    expect(api.transitionDurationBounds(clips(2, 6), fps(30))).toEqual({ min: 1 / 30, max: 1 });
  });

  it("TR02 is null when half the shorter clip is under one output frame", () => {
    expect(api.transitionDurationBounds(clips(4, 3), fps(25))).not.toBeNull();
    expect(api.transitionDurationBounds(clips(4, 0.06), fps(25))).toBeNull();
  });

  it("TR03 at exactly two output frames the window is one frame wide", () => {
    expect(api.transitionDurationBounds(clips(0.08, 4), fps(25))).toEqual({ min: 0.04, max: 0.04 });
  });
});

// Canvas design §4 转场: an edit inside the timeline Dialog keeps the chosen type and holds its length within the bounds;
// only a junction no transition fits becomes a Cut.
describe("a Dialog edit clamps a junction to its bounds (canvas design §4 转场)", () => {
  const api2 = miniTools as unknown as { clampTransitions: (clips: readonly Clip[], fps: Rational | null) => Clip[] };

  it.each([
    ["over the maximum to it", 1.4, 1],
    ["under the minimum to it", 0.01, 0.04],
    ["inside the bounds as it is", 0.5, 0.5],
  ] as const)("TR07 holds a length %s and keeps its type", (_name, duration, held) => {
    const [first, second] = clips(4, 2);
    expect(api2.clampTransitions([{ ...first!, transition: { kind: "wipeRight", duration } }, second!], fps(25)).map((clip) => clip.transition))
      .toEqual([{ kind: "wipeRight", duration: held }, { kind: "cut", duration: 0 }]);
  });

  it("TR08 makes a junction no transition fits a Cut, and without a frame rate holds by half the shorter clip", () => {
    const [first, second] = clips(4, 0.06);
    expect(api2.clampTransitions([first!, second!], fps(25))[0]!.transition).toEqual({ kind: "cut", duration: 0 });
    const [a, b] = clips(4, 2);
    expect(api2.clampTransitions([{ ...a!, transition: { kind: "fade", duration: 1.6 } }, b!], null)[0]!.transition).toEqual({ kind: "fade", duration: 1 });
  });
});

// frames-split §5.4 (前后端用同一个校验函数): the panel's pick keeps a junction only while it fits the bounds above,
// otherwise it becomes a Cut; the last clip carries no transition.
describe("a junction fits its bounds or becomes a Cut (frames-split §5.4; canvas design §4 转场)", () => {
  const cut = { kind: "cut", duration: 0 } as const;

  it("TR04 keeps a junction inside the bounds and makes the last clip a Cut", () => {
    const [first, second] = clips(4, 3);
    const fitted = api.fitTransitions([first!, { ...second!, transition: { kind: "fade", duration: 0.2 } }], fps(25));
    expect(fitted.map((clip) => clip.transition)).toEqual([{ kind: "fade", duration: 0.5 }, cut]);
  });

  it.each([
    ["longer than half the shorter clip", 2, 1.5],
    ["shorter than one output frame", 0.02, 3],
  ] as const)("TR05 turns a junction %s into a Cut", (_name, duration, second) => {
    const [first, last] = clips(4, second);
    expect(api.fitTransitions([{ ...first!, transition: { kind: "wipeLeft", duration } }, last!], fps(25))[0]!.transition).toEqual(cut);
  });

  it("TR09 keeps a length the Dialog wrote to the nearest microsecond of a bound, and still cuts one a frame away", () => {
    // Two 30000/1001 frames: both bounds are 1001/30000 s, which no whole number of microseconds equals.
    const [first, last] = clips(2002 / 30000, 3);
    const rate = fps(30000, 1001);
    expect(api.fitTransitions([{ ...first!, transition: { kind: "fade", duration: 0.033367 } }, last!], rate)[0]!.transition).toEqual({ kind: "fade", duration: 0.033367 });
    expect(api.fitTransitions([{ ...first!, transition: { kind: "fade", duration: 0.034 } }, last!], rate)[0]!.transition).toEqual(cut);
  });

  it("TR06 without a frame rate judges by half the shorter clip alone", () => {
    const [first, last] = clips(4, 3);
    expect(api.fitTransitions([{ ...first!, transition: { kind: "fade", duration: 0.02 } }, last!], null)[0]!.transition).toEqual({ kind: "fade", duration: 0.02 });
    expect(api.fitTransitions([{ ...first!, transition: { kind: "fade", duration: 1.6 } }, last!], null)[0]!.transition).toEqual(cut);
  });
});
