// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { TIMELINE_PREVIEW_DEFAULTS } from "@breatic/shared";

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

describe("preview multi-video sync (#1410 design §6.4)", () => {
  const approved = {
    drift_steer_seconds: 0.04,
    drift_hard_sync_seconds: 0.5,
    drift_catastrophic_seconds: 3,
    resume_seek_seconds: 0.15,
    drift_steer_rate: 0.03,
  };

  it("defaults to the approved steering, hard-sync, catastrophic and resume thresholds and the steer rate", () => {
    expect(timelineConfigSchema.parse({}).preview).toEqual(approved);
  });

  it("takes its defaults from TIMELINE_PREVIEW_DEFAULTS, so web's pre-limits fallback is the same value", () => {
    expect(timelineConfigSchema.parse({}).preview).toEqual({
      drift_steer_seconds: TIMELINE_PREVIEW_DEFAULTS.driftSteerSeconds,
      drift_hard_sync_seconds: TIMELINE_PREVIEW_DEFAULTS.driftHardSyncSeconds,
      drift_catastrophic_seconds: TIMELINE_PREVIEW_DEFAULTS.driftCatastrophicSeconds,
      resume_seek_seconds: TIMELINE_PREVIEW_DEFAULTS.resumeSeekSeconds,
      drift_steer_rate: TIMELINE_PREVIEW_DEFAULTS.driftSteerRate,
    });
  });

  it("keeps values given in the yaml", () => {
    const given = { drift_steer_seconds: 0.02, drift_hard_sync_seconds: 0.4, drift_catastrophic_seconds: 2, resume_seek_seconds: 0.1, drift_steer_rate: 0.05 };
    expect(timelineConfigSchema.parse({ preview: given }).preview).toEqual(given);
  });

  it("reads the approved values from the tracked yaml", () => {
    expect(getTimelineConfig().preview).toEqual(approved);
  });
});
