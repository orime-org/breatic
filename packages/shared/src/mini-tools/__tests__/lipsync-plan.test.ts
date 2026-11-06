// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
    ["a stopped person", reason([person("failed"), person("stopped", "gen", "person-2", 2)]), false],
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
