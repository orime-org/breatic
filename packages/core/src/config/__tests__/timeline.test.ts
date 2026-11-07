// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";

import { getTimelineConfig, timelineConfigSchema } from "@core/config/timeline.js";

/**
 * Parse a Timeline config whose only web-animation setting is the duration range.
 * @param durationSeconds The `web_animation.duration_seconds` block.
 * @returns Whether the schema accepts it.
 */
function acceptsDurations(durationSeconds: Record<string, number>): boolean {
  return timelineConfigSchema.safeParse({ web_animation: { duration_seconds: durationSeconds } }).success;
}

describe("web_animation.duration_seconds", () => {
  it("fills min, max and the dialog's opening duration when the block is absent", () => {
    expect(timelineConfigSchema.parse({}).web_animation.duration_seconds).toEqual({ min: 1, max: 60, default: 4 });
  });

  it("accepts an opening duration anywhere in min..max, its ends included", () => {
    expect(acceptsDurations({ min: 4, max: 4, default: 4 })).toBe(true);
    expect(acceptsDurations({ min: 2, max: 10, default: 2 })).toBe(true);
    expect(acceptsDurations({ min: 2, max: 10, default: 10 })).toBe(true);
  });

  it("refuses an opening duration outside min..max, so the dialog never opens on a value it would refuse", () => {
    expect(acceptsDurations({ min: 5, max: 10, default: 4 })).toBe(false);
    expect(acceptsDurations({ min: 1, max: 60, default: 61 })).toBe(false);
  });

  it("refuses a minimum above the maximum", () => {
    expect(acceptsDurations({ min: 11, max: 10, default: 10 })).toBe(false);
  });

  it("reads the tracked yaml with the approved four-second opening duration", () => {
    expect(getTimelineConfig().web_animation.duration_seconds.default).toBe(4);
  });
});
