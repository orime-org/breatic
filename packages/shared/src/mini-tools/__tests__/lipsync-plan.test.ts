// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 item 4 (execution design §9.4; D11-5, D12-4): one lip-sync failure reason
 * `{ kind: "lipsync", persons, shared }`; person steps are track, faces, clip, stem or gen, shared steps prepare, composite,
 * stitch or expired; only a reason whose every person line and shared step is `timeout` or `failed` is retryable, decided by
 * `lipsyncFailureRetryable` (shared `lipsync-plan.ts`). Read from the mini-tools entry by name so this compiles first.
 */
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type Schema = { safeParse: (value: unknown) => { success: boolean } };
const api = miniTools as unknown as { lipsyncFailureReasonSchema: Schema; lipsyncFailureRetryable: (reason: unknown) => boolean };

const person = (category: string, step = "gen", personId = "person-1", detectionNumber = 1): Record<string, unknown> => ({ personId, detectionNumber, step, category });
const reason = (persons: Record<string, unknown>[], shared: Record<string, unknown> | null = null): Record<string, unknown> => ({ kind: "lipsync", persons, shared });

describe("lip-sync failure reason (§97 D11-5; execution design §9.4)", () => {
  it.each([
    ["one person timing out", reason([person("timeout", "track")])],
    ["two people and a shared stitch failure", reason([person("no_face", "faces"), person("stopped", "gen", "person-2", 2)], { step: "stitch", category: "failed" })],
    ["only the whole run expiring", reason([], { step: "expired", category: "timeout" })],
  ])("LF01 accepts %s", (_name, value) => {
    expect(api.lipsyncFailureReasonSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["a shared step on a person", reason([person("failed", "prepare")])],
    ["a person step as the shared step", reason([], { step: "track", category: "failed" })],
    ["an unknown category", reason([person("lost")])],
    ["another reason kind", { ...reason([person("failed")]), kind: "segment" }],
    ["a person without its detection number", reason([{ personId: "person-1", step: "gen", category: "failed" }])],
  ])("LF02 refuses %s", (_name, value) => {
    expect(api.lipsyncFailureReasonSchema.safeParse(reason([person("failed")])).success).toBe(true);
    expect(api.lipsyncFailureReasonSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["every person timing out or failing", reason([person("timeout"), person("failed", "clip", "person-2", 2)]), true],
    ["a shared failure beside failed people", reason([person("failed")], { step: "composite", category: "failed" }), true],
    ["only the run expiring", reason([], { step: "expired", category: "timeout" }), true],
    ["a person with no face", reason([person("no_face", "faces"), person("timeout", "gen", "person-2", 2)]), false],
    ["a rejected model", reason([person("model_rejected")]), false],
    // Execution design §10.5: modelRunRetryable ignores stopped items, so they follow what stopped them.
    ["a stopped person beside a failed one", reason([person("failed"), person("stopped", "gen", "person-2", 2)]), true],
    ["a stopped person beside a person with no face", reason([person("no_face", "faces"), person("stopped", "gen", "person-2", 2)]), false],
  ] as const)("LF03 %s is retryable: %s", (_name, value, retryable) => {
    expect(api.lipsyncFailureRetryable(value)).toBe(retryable);
  });
});

// §97 D12-4 (execution design §9.3; DD 2026-11-05 multi-person lip-sync): the source range a run uses starts at 0 and ends at
// the timeline duration for cut_off (min(V, A)) or at the video duration for the other modes, then reaches the window end of
// any referenced person's anchor frame at or after that end, so tracking covers the anchor.
type Timeline = { duration: number; videoDuration: number; syncMode: "cut_off" | "silence" | "loop" | "bounce" | "remap" };
const range = (miniTools as unknown as { lipsyncUsedSourceRange: (timeline: Timeline, anchors: readonly { time: number; windowEnd: number }[]) => { start: 0; end: number } }).lipsyncUsedSourceRange;

describe("the used source range (§97 D12-4)", () => {
  it.each([
    ["cut_off ends at the timeline duration", { duration: 3, videoDuration: 5, syncMode: "cut_off" }, [], 3],
    ["silence ends at the video duration", { duration: 7, videoDuration: 5, syncMode: "silence" }, [], 5],
    ["loop ends at the video duration", { duration: 7, videoDuration: 5, syncMode: "loop" }, [], 5],
    ["an anchor before the end leaves it", { duration: 3, videoDuration: 5, syncMode: "cut_off" }, [{ time: 1, windowEnd: 1.04 }], 3],
    ["an anchor after the end extends it to the anchor's window end", { duration: 3, videoDuration: 5, syncMode: "cut_off" }, [{ time: 4, windowEnd: 4.04 }], 4.04],
    ["the latest anchor window wins", { duration: 3, videoDuration: 5, syncMode: "cut_off" }, [{ time: 3.5, windowEnd: 3.54 }, { time: 4.2, windowEnd: 4.24 }], 4.24],
    ["an anchor exactly at the end extends to its window end", { duration: 3, videoDuration: 5, syncMode: "cut_off" }, [{ time: 3, windowEnd: 3.04 }], 3.04],
  ] as const)("UR01 %s", (_name, timeline, anchors, end) => {
    expect(range(timeline, anchors)).toEqual({ start: 0, end });
  });
});

// §97 D12-4 (execution design §9.2; DD §7.1 row 128): the frozen lip-sync timeline is the dialogue planner's result with
// the video duration and mode, and `lipsyncSourceTickAt` maps a result tick to the source presentation tick per mode, in
// whole ticks of the source's clock: cut_off as is, silence as is before the video ends, loop over [0, V), bounce forth and
// back over [0, V), remap scaled from [0, A) onto [0, V). §97 D14-1 fixes the boundaries: the source tick s lies in [0, V],
// s = V meaning the last presentation frame; silence holds s = min(t, V); loop is half-open, s = t mod V (t = V gives 0);
// bounce has period 2V, u = t mod 2V and s = u when u <= V, else 2V - u (u = V gives V); remap is s = floor(t * V / duration)
// (t = duration gives V). `lipsyncSourceFrameAt(timeline, grid, k)` is the grid frame covering result frame k's s.
const lip = miniTools as unknown as {
  lipsyncTimeline: (input: { videoDuration: number; dialogues: readonly Record<string, unknown>[]; syncMode: Timeline["syncMode"] }) => Timeline;
  lipsyncSourceTickAt: (timeline: Timeline, timescale: number, tick: number) => { tick: number; reverse: boolean };
  lipsyncSourceFrameAt: (timeline: Timeline, grid: { fps: { numerator: number; denominator: number }; frameCount: number }, k: number) => number;
};
// 50 frames of 1/10 s: V = 50 ticks, last frame 49; result frame k is tick k.
const TABLE = { fps: { numerator: 10, denominator: 1 }, frameCount: 50 };
const rows = [
  { dialogueId: "60000000-0000-4000-8000-000000000001", personId: "person-1", audioInputId: "40000000-0000-4000-8000-000000000001", startTime: 0, duration: 3 },
  { dialogueId: "60000000-0000-4000-8000-000000000002", personId: "person-2", audioInputId: "40000000-0000-4000-8000-000000000002", startTime: 2, duration: 5 },
];

describe("the frozen lip-sync timeline and its source mapping (§97 D12-4; execution design §9.2)", () => {
  it.each([
    ["cut_off", 5], ["silence", 7], ["loop", 7], ["bounce", 7], ["remap", 7],
  ] as const)("LT01 %s: the timeline carries the planned duration, the video duration and the mode", (syncMode, duration) => {
    expect(lip.lipsyncTimeline({ videoDuration: 5, dialogues: rows, syncMode })).toEqual({ duration, videoDuration: 5, syncMode });
  });

  it.each([
    ["cut_off", 5, [[15, 15, false], [49, 49, false]]],
    ["silence", 7, [[15, 15, false], [49, 49, false]]],
    ["loop", 7, [[15, 15, false], [65, 15, false]]],
    ["bounce", 7, [[15, 15, false], [60, 40, true]]],
    ["remap", 7, [[35, 25, false], [14, 10, false]]],
  ] as const)("LS01 %s maps a result tick to a source tick", (syncMode, duration, points) => {
    const timeline = { duration, videoDuration: 5, syncMode };
    for (const [t, tick, reverse] of points) expect(lip.lipsyncSourceTickAt(timeline, 10, t)).toEqual({ tick, reverse });
  });

  it.each([
    ["cut_off at the start and at its end", "cut_off", 5, [[0, 0], [50, 50]]],
    ["silence at the video end and through the held tail", "silence", 7, [[50, 50], [60, 50], [70, 50]]],
    ["loop at the period boundary restarts at 0", "loop", 7, [[0, 0], [50, 0], [70, 20]]],
    ["bounce at V is the last frame and at 2V back at 0", "bounce", 12, [[0, 0], [50, 50], [75, 25], [100, 0], [120, 20]]],
    ["remap at its end reaches V", "remap", 7, [[0, 0], [70, 50]]],
  ] as const)("LS01 boundary (§97 D14-1): %s", (_name, syncMode, duration, points) => {
    const timeline = { duration, videoDuration: 5, syncMode };
    for (const [t, tick] of points) expect(lip.lipsyncSourceTickAt(timeline, 10, t).tick).toBe(tick);
  });

  it.each([
    ["cut_off inside and at its end", "cut_off", 5, [[12, 12], [50, 49]]],
    ["silence through the held tail", "silence", 7, [[49, 49], [50, 49], [70, 49]]],
    ["loop just before and at the period boundary", "loop", 7, [[49, 49], [50, 0], [62, 12]]],
    ["bounce at V and at 2V", "bounce", 12, [[50, 49], [100, 0], [63, 37]]],
    ["remap inside and at its end", "remap", 7, [[35, 25], [70, 49]]],
  ] as const)("LS02 the covering source frame (§97 D14-1): %s", (_name, syncMode, duration, points) => {
    const timeline = { duration, videoDuration: 5, syncMode };
    for (const [k, frame] of points) expect(lip.lipsyncSourceFrameAt(timeline, TABLE, k)).toBe(frame);
  });
});
