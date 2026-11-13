// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The fixed Timeline frame presets (#1502): a document stores only its frame width and height, and its preset is read
 * back from that size. Every preset has a short side of 1080.
 */

import type { TimelineSettings } from "@shared/timeline/schema.js";

/** The frame presets in the order the ratio control lists them. */
export const TIMELINE_FRAME_PRESETS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "2:3": { width: 1080, height: 1620 },
  "21:9": { width: 2520, height: 1080 },
} as const;

/** A frame preset key such as `9:16`. */
export type TimelineFramePreset = keyof typeof TIMELINE_FRAME_PRESETS;

/** The preset keys in listing order. */
export const TIMELINE_FRAME_PRESET_KEYS = Object.keys(TIMELINE_FRAME_PRESETS) as TimelineFramePreset[];

/**
 * The preset a stored frame size is.
 * @param size - The stored settings; only the width and height count.
 * @returns The preset key, or undefined for a size outside the table.
 * @throws {never} Never.
 */
export function timelineFramePresetOf(size: Pick<TimelineSettings, "width" | "height"> & Partial<TimelineSettings>): TimelineFramePreset | undefined {
  return TIMELINE_FRAME_PRESET_KEYS.find((key) => TIMELINE_FRAME_PRESETS[key].width === size.width && TIMELINE_FRAME_PRESETS[key].height === size.height);
}
