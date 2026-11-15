// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The render container's verdict on the video the renderer wrote (#1490 design §6.2): what ffprobe measured must have
 * exactly the frame count, width and height the export froze, or the export fails as `frame_mismatch`.
 */

import { describe, expect, it } from "vitest";

import { judgeWebAnimationRender } from "../web-animation-render.js";

const EXPECTED = { durationFrames: 144, width: 1080, height: 1920 };

describe("judgeWebAnimationRender", () => {
  it("passes a video with the frozen frame count and size", () => {
    expect(judgeWebAnimationRender({ frames: 144, width: 1080, height: 1920 }, EXPECTED)).toBeNull();
  });

  it.each([
    ["one frame short", { frames: 143, width: 1080, height: 1920 }],
    ["one frame over", { frames: 145, width: 1080, height: 1920 }],
    ["the wrong width", { frames: 144, width: 1078, height: 1920 }],
    ["the wrong height", { frames: 144, width: 1080, height: 1918 }],
    ["no frames counted", { frames: null, width: 1080, height: 1920 }],
  ])("fails a video with %s as frame_mismatch", (_name, probe) => {
    expect(judgeWebAnimationRender(probe, EXPECTED)).toBe("frame_mismatch");
  });
});
