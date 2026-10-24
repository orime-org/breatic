// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface SourceFrame { frameIndex: number; pts: number }
interface FrameTable { frames: SourceFrame[]; videoEnd: number }
interface FrameRequest { mode: "first" | "last" | "current" | "interval"; currentTime?: number; interval?: number }
interface FrameOutput extends SourceFrame { outputIndex: number }
interface SegmentOutput { outputIndex: number; start: number; end: number }
interface ExpansionFrame { x: number; y: number; width: number; height: number }
interface Dialogue { dialogueId: string; personId: string; audioInputId: string; startTime: number; duration: number }
type SyncMode = "cut_off" | "silence" | "loop" | "bounce" | "remap";
interface Clip { clipId: string; inputId: string; in: number; out: number; transition: { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number } }
interface PlannedClip extends Clip { start: number; end: number; overlap: number }
interface PlanApi {
  planVideoFrames: (source: FrameTable, request: FrameRequest) => FrameOutput[];
  planVideoSplit: (source: FrameTable, cuts: readonly number[]) => SegmentOutput[];
  chunkVideoOutputs: <T>(outputs: readonly T[], chunkSize: number) => T[][];
  planVideoExpand: (source: { width: number; height: number }, frame: ExpansionFrame) => { width: number; height: number; sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number };
  planVideoDialogues: (input: { videoDuration: number; dialogues: readonly Dialogue[]; syncMode: SyncMode }) => { duration: number; dialogues: Dialogue[] };
  planVideoTimeline: (clips: readonly Clip[]) => { duration: number; clips: PlannedClip[] };
}

const api = miniTools as unknown as PlanApi;
const source: FrameTable = { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.04 }, { frameIndex: 2, pts: 0.12 }, { frameIndex: 3, pts: 0.2 }], videoEnd: 0.28 };
const dialogues: Dialogue[] = [
  { dialogueId: "10000000-0000-4000-8000-000000000001", personId: "person-a", audioInputId: "20000000-0000-4000-8000-000000000001", startTime: 0, duration: 4 },
  { dialogueId: "10000000-0000-4000-8000-000000000002", personId: "person-a", audioInputId: "20000000-0000-4000-8000-000000000002", startTime: 1.25, duration: 4 },
  { dialogueId: "10000000-0000-4000-8000-000000000003", personId: "person-a", audioInputId: "20000000-0000-4000-8000-000000000001", startTime: 3, duration: 7 },
];
const clips: Clip[] = [
  { clipId: "30000000-0000-4000-8000-000000000001", inputId: "40000000-0000-4000-8000-000000000001", in: 1, out: 4, transition: { kind: "fade", duration: 0.5 } },
  { clipId: "30000000-0000-4000-8000-000000000002", inputId: "40000000-0000-4000-8000-000000000002", in: 2, out: 6, transition: { kind: "cut", duration: 0 } },
];

describe("complete video tool execution plans", () => {
  it("exports every shared plan entry point", () => {
    expect(["planVideoFrames", "planVideoSplit", "chunkVideoOutputs", "planVideoExpand", "planVideoDialogues", "planVideoTimeline"].filter((key) => !(key in miniTools))).toEqual([]);
  });

  describe("actual displayed frame selection", () => {
    it.each([
      [{ mode: "first" }, [{ outputIndex: 0, frameIndex: 0, pts: 0 }]],
      [{ mode: "last" }, [{ outputIndex: 0, frameIndex: 3, pts: 0.2 }]],
      [{ mode: "current", currentTime: 0.13 }, [{ outputIndex: 0, frameIndex: 2, pts: 0.12 }]],
      [{ mode: "current", currentTime: 0.12 }, [{ outputIndex: 0, frameIndex: 2, pts: 0.12 }]],
    ] as const)("uses displayed source frames for %j", (request, expected) => {
      expect(api.planVideoFrames(source, request)).toEqual(expected);
    });

    it("deduplicates interval samples that select the same displayed frame", () => {
      expect(api.planVideoFrames(source, { mode: "interval", interval: 0.05 })).toEqual([
        { outputIndex: 0, frameIndex: 0, pts: 0 },
        { outputIndex: 1, frameIndex: 1, pts: 0.04 },
        { outputIndex: 2, frameIndex: 2, pts: 0.12 },
        { outputIndex: 3, frameIndex: 3, pts: 0.2 },
      ]);
    });

    it("selects the last displayed frame independently of the ending timestamp", () => {
      expect(api.planVideoFrames({ ...source, videoEnd: 0.4 }, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 3, pts: 0.2 }]);
    });

    it("returns the single displayed frame for every selection mode", () => {
      const one = { frames: [{ frameIndex: 0, pts: 0 }], videoEnd: 0.04 };
      for (const mode of ["first", "last", "current", "interval"] as const) expect(api.planVideoFrames(one, { mode, currentTime: 0, interval: 0.01 })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0 }]);
    });

    // Source-clock coverage and complete displayed-frame identities follow inner#1306.
    it("retains positive first PTS without shifting the source frame clock", () => {
      const shifted = { frames: [{ frameIndex: 0, pts: 0.04 }, { frameIndex: 1, pts: 0.12 }, { frameIndex: 2, pts: 0.2 }], videoEnd: 0.28 };
      expect(api.planVideoFrames(shifted, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0.04 }]);
      expect(api.planVideoFrames(shifted, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 2, pts: 0.2 }]);
      expect(api.planVideoFrames(shifted, { mode: "current", currentTime: 0.13 })).toEqual([{ outputIndex: 0, frameIndex: 1, pts: 0.12 }]);
    });

    it("retains negative first PTS for the first and covering displayed frame", () => {
      const shifted = { frames: [{ frameIndex: 0, pts: -0.04 }, { frameIndex: 1, pts: 0.04 }, { frameIndex: 2, pts: 0.12 }], videoEnd: 0.2 };
      expect(api.planVideoFrames(shifted, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: -0.04 }]);
      expect(api.planVideoFrames(shifted, { mode: "current", currentTime: 0.01 })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: -0.04 }]);
      expect(api.planVideoFrames(shifted, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 2, pts: 0.12 }]);
    });

    it("retains presentation order for first and last frames sharing a PTS", () => {
      const repeated = { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0 }, { frameIndex: 2, pts: 0.12 }, { frameIndex: 3, pts: 0.12 }], videoEnd: 0.2 };
      expect(api.planVideoFrames(repeated, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0 }]);
      expect(api.planVideoFrames(repeated, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 3, pts: 0.12 }]);
    });

    it.each([
      [0.125 - Number.EPSILON, { outputIndex: 0, frameIndex: 0, pts: 0 }],
      [0.125, { outputIndex: 0, frameIndex: 1, pts: 0.125 }],
      [0.125 + Number.EPSILON, { outputIndex: 0, frameIndex: 1, pts: 0.125 }],
    ] as const)("selects the covering frame at the source boundary %s", (currentTime, expected) => {
      const boundary = { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.125 }], videoEnd: 0.25 };
      expect(api.planVideoFrames(boundary, { mode: "current", currentTime })).toEqual([expected]);
    });

    it.each([Number.MIN_VALUE, 1e-300])("deduplicates every displayed frame for a very small positive interval %s", (interval) => {
      expect(api.planVideoFrames(source, { mode: "interval", interval })).toEqual([
        { outputIndex: 0, frameIndex: 0, pts: 0 },
        { outputIndex: 1, frameIndex: 1, pts: 0.04 },
        { outputIndex: 2, frameIndex: 2, pts: 0.12 },
        { outputIndex: 3, frameIndex: 3, pts: 0.2 },
      ]);
    });

    it("preserves narrow sampling windows on both sides of exact source-clock samples", () => {
      const boundary = { frames: [
        { frameIndex: 0, pts: 0 },
        { frameIndex: 1, pts: 0.125 + Number.EPSILON },
        { frameIndex: 2, pts: 0.25 - Number.EPSILON },
        { frameIndex: 3, pts: 0.25 + Number.EPSILON },
        { frameIndex: 4, pts: 0.375 + Number.EPSILON },
        { frameIndex: 5, pts: 0.5 },
      ], videoEnd: 0.625 };
      // Exact samples are 0, 0.125, 0.25, 0.375 and 0.5; the endpoint is excluded.
      expect(api.planVideoFrames(boundary, { mode: "interval", interval: 0.125 })).toEqual([
        { outputIndex: 0, frameIndex: 0, pts: 0 },
        { outputIndex: 1, frameIndex: 2, pts: 0.25 - Number.EPSILON },
        { outputIndex: 2, frameIndex: 3, pts: 0.25 + Number.EPSILON },
        { outputIndex: 3, frameIndex: 5, pts: 0.5 },
      ]);
    });

    it("reports a source with no displayed frames", () => {
      expect(() => api.planVideoFrames({ frames: [], videoEnd: 0.4 }, { mode: "first" })).toThrow();
    });

    it.each([
      { frames: [{ frameIndex: 1, pts: 0 }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 2, pts: 0.04 }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 0, pts: 0.04 }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: 0.12 }, { frameIndex: 1, pts: 0.04 }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: 0.28 }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: 0.3 }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: Number.NaN }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: Number.POSITIVE_INFINITY }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: Number.NEGATIVE_INFINITY }], videoEnd: 0.28 },
      { frames: [{ frameIndex: 0, pts: 0 }], videoEnd: Number.POSITIVE_INFINITY },
    ])("rejects an incomplete or invalid source frame clock %j", (invalid) => {
      expect(() => api.planVideoFrames(invalid, { mode: "first" })).toThrow();
      expect(() => api.planVideoSplit(invalid, [])).toThrow();
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects an invalid interval %s", (interval) => {
      expect(() => api.planVideoFrames(source, { mode: "interval", interval })).toThrow();
    });

    it("rejects current and interval modes without their required source-clock values", () => {
      expect(() => api.planVideoFrames(source, { mode: "current" })).toThrow();
      expect(() => api.planVideoFrames(source, { mode: "interval" })).toThrow();
    });
  });

  describe("complete split planning", () => {
    it("normalizes exact source boundaries into all N plus one segments", () => {
      expect(api.planVideoSplit(source, [0.12, 0, 0.04, 0.12, 0.28])).toEqual([
        { outputIndex: 0, start: 0, end: 0.04 },
        { outputIndex: 1, start: 0.04, end: 0.12 },
        { outputIndex: 2, start: 0.12, end: 0.28 },
      ]);
    });

    it("keeps the entire video when there are no internal cuts", () => {
      expect(api.planVideoSplit(source, [])).toEqual([{ outputIndex: 0, start: 0, end: 0.28 }]);
      expect(api.planVideoSplit(source, [0, 0.28])).toEqual([{ outputIndex: 0, start: 0, end: 0.28 }]);
    });

    it("normalizes neighboring source-clock cuts to one exact displayed boundary", () => {
      const boundary = { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.125 }, { frameIndex: 2, pts: 0.25 }], videoEnd: 0.375 };
      expect(api.planVideoSplit(boundary, [0.125 - Number.EPSILON, 0.125, 0.125 + Number.EPSILON])).toEqual([
        { outputIndex: 0, start: 0, end: 0.125 },
        { outputIndex: 1, start: 0.125, end: 0.375 },
      ]);
    });

    it("keeps normalized segment plans unchanged under boundary permutations", () => {
      const cuts = [0, 0.04, 0.12, 0.12, 0.28];
      const expected = [{ outputIndex: 0, start: 0, end: 0.04 }, { outputIndex: 1, start: 0.04, end: 0.12 }, { outputIndex: 2, start: 0.12, end: 0.28 }];
      fc.assert(fc.property(fc.shuffledSubarray(cuts, { minLength: cuts.length, maxLength: cuts.length }), (permutation) => {
        expect(api.planVideoSplit(source, permutation)).toEqual(expected);
      }));
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects a non-finite cut %s", (cut) => {
      expect(() => api.planVideoSplit(source, [cut])).toThrow();
    });
  });

  describe("bounded container chunks", () => {
    it("keeps all seventeen output identities and recipes across eight-output jobs", () => {
      const outputs = Array.from({ length: 17 }, (_, outputIndex) => ({ outputIndex, recipe: { kind: "split", start: outputIndex, end: outputIndex + 1 } }));
      const chunks = api.chunkVideoOutputs(outputs, 8);
      expect(chunks.map((chunk) => chunk.length)).toEqual([8, 8, 1]);
      expect(chunks.flat()).toEqual(outputs);
      expect(chunks[2]).toEqual([outputs[16]]);
    });

    it("preserves arbitrary complete output sequences without mutation", () => {
      fc.assert(fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 16 }), (outputs, cap) => {
        const before = [...outputs];
        const chunks = api.chunkVideoOutputs(outputs, cap);
        expect(chunks.flat()).toEqual(before);
        expect(outputs).toEqual(before);
        expect(chunks.map((chunk) => chunk.length)).toEqual(Array.from({ length: Math.ceil(outputs.length / cap) }, (_, index) => Math.min(cap, outputs.length - index * cap)));
      }));
    });

    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid per-job capacity %s", (cap) => {
      expect(() => api.chunkVideoOutputs([1, 2], cap)).toThrow();
    });
  });

  describe("fixed-source expansion geometry", () => {
    it("retains all biased margins in source pixel coordinates", () => {
      expect(api.planVideoExpand({ width: 256, height: 128 }, { x: -0.125, y: -0.375, width: 1.375, height: 2 })).toEqual({ width: 352, height: 256, sourceX: 32, sourceY: 48, sourceWidth: 256, sourceHeight: 128 });
    });

    it("supports a larger target with the original aspect ratio", () => {
      expect(api.planVideoExpand({ width: 256, height: 128 }, { x: -0.125, y: -0.125, width: 2, height: 2 })).toEqual({ width: 512, height: 256, sourceX: 32, sourceY: 16, sourceWidth: 256, sourceHeight: 128 });
    });
  });

  describe("complete dialogue clock", () => {
    it("rejects a non-finite derived audio endpoint from finite row values", () => {
      const overflow = [{ ...dialogues[0]!, startTime: Number.MAX_VALUE, duration: Number.MAX_VALUE }];
      expect(() => api.planVideoDialogues({ videoDuration: 5, dialogues: overflow, syncMode: "silence" })).toThrow();
    });

    it.each<SyncMode>(["cut_off", "silence", "loop", "bounce", "remap"])("retains every independent row in %s mode", (syncMode) => {
      expect(api.planVideoDialogues({ videoDuration: 5, dialogues, syncMode })).toEqual({ duration: syncMode === "cut_off" ? 5 : 10, dialogues });
    });

    it.each([
      ["cut_off", 2],
      ["silence", 5],
      ["loop", 2],
      ["bounce", 2],
      ["remap", 2],
    ] as const)("applies the complete %s duration rule to a shorter audio stem", (syncMode, duration) => {
      const shorter = [{ ...dialogues[0]!, startTime: 0, duration: 2 }];
      expect(api.planVideoDialogues({ videoDuration: 5, dialogues: shorter, syncMode })).toEqual({ duration, dialogues: shorter });
    });

    it("retains explicit start positions and overlapping audio for the same person", () => {
      const before = structuredClone(dialogues);
      const plan = api.planVideoDialogues({ videoDuration: 5, dialogues, syncMode: "loop" });
      expect(plan.dialogues.map((row) => [row.dialogueId, row.personId, row.audioInputId, row.startTime])).toEqual(before.map((row) => [row.dialogueId, row.personId, row.audioInputId, row.startTime]));
      expect(dialogues).toEqual(before);
      expect(plan.duration).toBe(10);
    });
  });

  describe("one timeline clock", () => {
    it("places the second trimmed clip at the shared overlap boundary", () => {
      expect(api.planVideoTimeline(clips)).toEqual({ duration: 6.5, clips: [
        { ...clips[0], start: 0, end: 3, overlap: 0.5 },
        { ...clips[1], start: 2.5, end: 6.5, overlap: 0 },
      ] });
    });

    it("keeps source identity independent for repeated uses of one input", () => {
      const repeated = [clips[0]!, { ...clips[1]!, inputId: clips[0]!.inputId }];
      const plan = api.planVideoTimeline(repeated);
      expect(plan.clips.map((clip) => [clip.clipId, clip.inputId, clip.in, clip.out, clip.start])).toEqual([
        [clips[0]!.clipId, clips[0]!.inputId, 1, 4, 0],
        [clips[1]!.clipId, clips[0]!.inputId, 2, 6, 2.5],
      ]);
      expect(plan.duration).toBe(6.5);
    });

    it("preserves the source clips while deriving composition times", () => {
      const before = structuredClone(clips);
      api.planVideoTimeline(clips);
      expect(clips).toEqual(before);
    });

    it("rejects a non-finite composition endpoint from finite source ranges", () => {
      const overflow = clips.map((clip) => ({ ...clip, in: 0, out: Number.MAX_VALUE, transition: { kind: "cut" as const, duration: 0 } }));
      expect(() => api.planVideoTimeline(overflow)).toThrow();
    });
  });
});
