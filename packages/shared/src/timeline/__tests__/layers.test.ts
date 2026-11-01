// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { activeTimelineClipAt, nextTimelinePlaybackBoundary } from "../layers.js";
import { MAIN, V2, V3, cid, clip, timeline, track } from "./edit-fixtures.js";

const LOW = cid(1);
const TOP = cid(2);
const layered = timeline([clip(LOW, MAIN, 0, 480), clip(TOP, V2, 100, 48)]);
const allReady = new Set([LOW, TOP]);

describe("activeTimelineClipAt", () => {
  it("shows the highest-order ready clip and switches at the upper clip's start and end", () => {
    expect(activeTimelineClipAt(layered, allReady, 99)?.id).toBe(LOW);
    expect(activeTimelineClipAt(layered, allReady, 100)?.id).toBe(TOP);
    expect(activeTimelineClipAt(layered, allReady, 147)?.id).toBe(TOP);
    expect(activeTimelineClipAt(layered, allReady, 148)?.id).toBe(LOW);
    expect(activeTimelineClipAt(layered, allReady, 120)).toEqual(layered.clips[TOP]);
  });

  it("falls back to the lower clip when the upper clip is not ready", () => {
    expect(activeTimelineClipAt(layered, new Set([LOW]), 120)?.id).toBe(LOW);
  });

  it("returns null in a gap, past the end and when nothing is ready", () => {
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(activeTimelineClipAt(gapped, allReady, 15)).toBeNull();
    expect(activeTimelineClipAt(gapped, allReady, 30)).toBeNull();
    expect(activeTimelineClipAt(layered, new Set(), 120)).toBeNull();
  });

  it("breaks a tie between equal track orders by clip id", () => {
    const tied = timeline([clip(TOP, V2, 0, 10), clip(LOW, V3, 0, 10)], [track(MAIN, 0), track(V2, 1), track(V3, 1)]);
    expect(activeTimelineClipAt(tied, allReady, 5)?.id).toBe(LOW);
  });
});

describe("nextTimelinePlaybackBoundary", () => {
  it("stops at every ready clip start and end strictly after the frame", () => {
    expect(nextTimelinePlaybackBoundary(layered, allReady, 90, 480)).toBe(100);
    expect(nextTimelinePlaybackBoundary(layered, allReady, 100, 480)).toBe(148);
    expect(nextTimelinePlaybackBoundary(layered, allReady, 148, 480)).toBe(480);
  });

  it("ignores clips that are not ready", () => {
    expect(nextTimelinePlaybackBoundary(layered, new Set([LOW]), 90, 480)).toBe(480);
  });

  it("crosses a gap to the next clip start", () => {
    const gapped = timeline([clip(LOW, MAIN, 0, 10), clip(TOP, MAIN, 20, 10)]);
    expect(nextTimelinePlaybackBoundary(gapped, allReady, 10, 30)).toBe(20);
  });

  it("is capped by the end frame", () => {
    expect(nextTimelinePlaybackBoundary(layered, allReady, 100, 120)).toBe(120);
    expect(nextTimelinePlaybackBoundary(layered, new Set(), 0, 480)).toBe(480);
  });
});
