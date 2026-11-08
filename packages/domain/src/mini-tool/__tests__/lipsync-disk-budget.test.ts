// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { lipsyncMonotonicSegments, planLipsyncCompositeChunks, type LipsyncTimeline, type VideoPresentationTable } from "@breatic/shared/mini-tools";
import { lipsyncCompositeChunks, lipsyncCompositeRawBytes, lipsyncRawDiskBytes } from "../lipsync-admission.js";

// 1080p at 30 fps, two people with 512 px crops, on standard-4's configured 20 GB disk with half of it for raw frames.
const FRAMES = { width: 1920, height: 1080, alpha: false, persons: 2, cropSize: 512 };
const BUDGET = lipsyncRawDiskBytes(20, 0.5);
// A composite frame's work at the configured rates and the share of a two-hour task: the time share alone keeps hours in one chunk.
const FRAME_SECONDS = 0.0095;
const SHARE_SECONDS = 3597;

/**
 * A constant-rate 30 fps table of this many frames.
 * @param count - The frames.
 * @returns The table.
 */
function table30(count: number): VideoPresentationTable {
  return { schemaVersion: 1, timescale: 30, runs: [{ start: 0, count, step: 1, duration: 1 }] };
}

// Execution design paragraph before §9.4: admission splits the composite by the disk budget as well as by the time share.
describe("lip-sync composite chunks fit the raw disk budget (execution design paragraph before §9.4)", () => {
  it.each([
    ["a 2 min cut_off", { duration: 120, videoDuration: 120, syncMode: "cut_off" }, 3600],
    ["a 2 min remap of a 4 min video", { duration: 120, videoDuration: 240, syncMode: "remap" }, 7200],
    ["a 3 min loop of a 50 s video", { duration: 180, videoDuration: 50, syncMode: "loop" }, 1500],
  ] as const)("LD01 %s at 1080p is split so every chunk's raw frames fit", (_case, timeline: LipsyncTimeline, frames) => {
    const table = table30(frames);
    const segments = lipsyncMonotonicSegments(timeline, table, Array.from({ length: frames }, (_unused, at) => at % 30 === 0));
    const byTime = planLipsyncCompositeChunks({ segments, frameSeconds: FRAME_SECONDS, targetSeconds: SHARE_SECONDS });
    // The guard: the time share alone leaves a chunk over the disk.
    expect(Math.max(...byTime.map((window) => lipsyncCompositeRawBytes(timeline, table, window, FRAMES)))).toBeGreaterThan(BUDGET);
    const chunks = lipsyncCompositeChunks({ timeline, table, segments, frameSeconds: FRAME_SECONDS, targetSeconds: SHARE_SECONDS, frames: FRAMES, diskBytes: BUDGET });
    for (const window of chunks) expect(lipsyncCompositeRawBytes(timeline, table, window, FRAMES), JSON.stringify(window)).toBeLessThanOrEqual(BUDGET);
    // The chunks still tile the result, each inside one time chunk.
    expect(chunks[0]!.start).toBe(0);
    for (let at = 1; at < chunks.length; at += 1) expect(chunks[at]!.start).toBe(chunks[at - 1]!.end);
    expect(chunks.at(-1)!.end).toBe(segments.at(-1)!.resultEnd);
    for (const window of chunks) expect(byTime.some((chunk) => chunk.start <= window.start && window.end <= chunk.end)).toBe(true);
  });

  it("LD02 a chunk's raw bytes are its shown source frames, its result frames and each person's result frames", () => {
    const timeline: LipsyncTimeline = { duration: 4, videoDuration: 8, syncMode: "remap" };
    // Result frames [30, 60) of the remap show source frames 60..118: 59 source frames.
    const picture = 1920 * 1080 * 1.5;
    expect(lipsyncCompositeRawBytes(timeline, table30(240), { start: 30, end: 60 }, FRAMES)).toBe(59 * picture + 30 * picture + 2 * 30 * 512 * 512 * 1.5);
  });
});
