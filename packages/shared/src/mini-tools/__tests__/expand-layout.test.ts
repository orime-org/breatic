// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { expandLayout, isExpanded, videoExpandLayout } from "../expand-layout.js";

// Execution design §10.5 geometry row: expandLayout moves to shared unchanged (image expand keeps it); video expand
// rounds its target up to even sides and reports whether the long side is over the configured cap, without clamping.
describe("expand layout (execution design §10.5)", () => {
  it("EL01 the image layout is unchanged: an odd source at frame width 1 is not expanded", () => {
    const frame = { x: 0, y: 0, width: 1, height: 1 };
    expect(expandLayout(frame, { width: 853, height: 480 })).toEqual({ width: 853, height: 480, sourceX: 0, sourceY: 0 });
    expect(isExpanded(frame, { width: 853, height: 480 })).toBe(false);
  });

  it("EL02 the image layout keeps its sizes for a left-and-up expansion", () => {
    expect(expandLayout({ x: -0.125, y: -0.375, width: 1.375, height: 2 }, { width: 256, height: 128 })).toEqual({ width: 352, height: 256, sourceX: 32, sourceY: 48 });
  });

  it("EL03 the video layout rounds each side up to even and keeps the source offset", () => {
    expect(videoExpandLayout({ x: -0.1, y: 0, width: 1.3, height: 1 }, { width: 853, height: 479 }, 4096)).toEqual({ width: 1110, height: 480, sourceX: 85, sourceY: 0, overSide: false });
  });

  it("EL04 a square target is laid out like any other", () => {
    expect(videoExpandLayout({ x: -0.5, y: 0, width: 2, height: 1 }, { width: 400, height: 800 }, 4096)).toMatchObject({ width: 800, height: 800 });
  });

  it("EL05 a long side of 4097 is reported over the cap and not clamped", () => {
    const layout = videoExpandLayout({ x: 0, y: 0, width: 4097 / 2048, height: 1 }, { width: 2048, height: 1080 }, 4096);
    expect(layout.width).toBeGreaterThan(4096);
    expect(layout.overSide).toBe(true);
  });
});
