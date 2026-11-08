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

describe("web_animation.font_set_version", () => {
  it("defaults to 3, the set that carries Noto Sans JP and Noto Sans TC", () => {
    expect(timelineConfigSchema.parse({}).web_animation.font_set_version).toBe(3);
  });

  it("reads 3 from the tracked yaml, so new packages name the set with Japanese and Traditional Chinese glyphs", () => {
    expect(getTimelineConfig().web_animation.font_set_version).toBe(3);
  });
});

describe("web_animation preview instance pool (inner#1711 design §7.4, §10)", () => {
  it("defaults the premount lead to 2000 ms and the idle instance cap to 8", () => {
    const config = timelineConfigSchema.parse({}).web_animation;
    expect(config).toMatchObject({ preview_premount_ms: 2000, preview_idle_instances_max: 8 });
  });

  it("reads 2000 ms and 8 from the tracked yaml", () => {
    expect(getTimelineConfig().web_animation).toMatchObject({ preview_premount_ms: 2000, preview_idle_instances_max: 8 });
  });
});
