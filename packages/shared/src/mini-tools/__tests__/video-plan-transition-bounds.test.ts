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
type Bounds = (clips: readonly Clip[], fps: number) => { min: number; max: number } | null;
const api = miniTools as unknown as { transitionDurationBounds: Bounds };
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
    expect(api.transitionDurationBounds(clips(4, 3), 25)).toEqual({ min: 1 / 25, max: 1.5 });
    expect(api.transitionDurationBounds(clips(2, 6), 30)).toEqual({ min: 1 / 30, max: 1 });
  });

  it("TR02 is null when half the shorter clip is under one output frame", () => {
    expect(api.transitionDurationBounds(clips(4, 3), 25)).not.toBeNull();
    expect(api.transitionDurationBounds(clips(4, 0.06), 25)).toBeNull();
  });

  it("TR03 at exactly two output frames the window is one frame wide", () => {
    expect(api.transitionDurationBounds(clips(0.08, 4), 25)).toEqual({ min: 0.04, max: 0.04 });
  });
});
