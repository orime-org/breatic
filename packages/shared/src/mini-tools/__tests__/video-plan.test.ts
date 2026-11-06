// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface ExpansionFrame { x: number; y: number; width: number; height: number }
interface Dialogue { dialogueId: string; personId: string; audioInputId: string; startTime: number; duration: number }
type SyncMode = "cut_off" | "silence" | "loop" | "bounce" | "remap";
interface Clip { clipId: string; inputId: string; in: number; out: number; transition: { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number } }
interface PlannedClip extends Clip { start: number; end: number; overlap: number }
interface PlanApi {
  chunkVideoOutputs: <T>(outputs: readonly T[], chunkSize: number) => T[][];
  planVideoExpand: (source: { width: number; height: number }, frame: ExpansionFrame) => { width: number; height: number; sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number };
  planVideoDialogues: (input: { videoDuration: number; dialogues: readonly Dialogue[]; syncMode: SyncMode }) => { duration: number; dialogues: Dialogue[] };
  // §97 D12-2, D13-2: the timeline planner takes the output frame rate as the plan's exact rational and plans on its grid.
  planVideoTimeline: (clips: readonly Clip[], fps: Rational) => { duration: number; clips: PlannedClip[] };
}
type Rational = { numerator: string; denominator: string };
const fps = (numerator: number, denominator = 1): Rational => ({ numerator: String(numerator), denominator: String(denominator) });
// Every value below lies on the 30 fps grid, so the frame-grid planner keeps the earlier seconds (4.4.5: contract changed).
const FPS30 = fps(30);

const api = miniTools as unknown as PlanApi;
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
      expect(api.planVideoTimeline(clips, FPS30)).toEqual({ duration: 6.5, clips: [
        { ...clips[0], start: 0, end: 3, overlap: 0.5 },
        { ...clips[1], start: 2.5, end: 6.5, overlap: 0 },
      ] });
    });

    it("keeps source identity independent for repeated uses of one input", () => {
      const repeated = [clips[0]!, { ...clips[1]!, inputId: clips[0]!.inputId }];
      const plan = api.planVideoTimeline(repeated, FPS30);
      expect(plan.clips.map((clip) => [clip.clipId, clip.inputId, clip.in, clip.out, clip.start])).toEqual([
        [clips[0]!.clipId, clips[0]!.inputId, 1, 4, 0],
        [clips[1]!.clipId, clips[0]!.inputId, 2, 6, 2.5],
      ]);
      expect(plan.duration).toBe(6.5);
    });

    it("preserves the source clips while deriving composition times", () => {
      const before = structuredClone(clips);
      api.planVideoTimeline(clips, FPS30);
      expect(clips).toEqual(before);
    });

    it("rejects a non-finite composition endpoint from finite source ranges", () => {
      const overflow = clips.map((clip) => ({ ...clip, in: 0, out: Number.MAX_VALUE, transition: { kind: "cut" as const, duration: 0 } }));
      expect(() => api.planVideoTimeline(overflow, FPS30)).toThrow();
    });

    // §97 D12-2 (frames-split §7.17 转场输出档 row, §5.4 切块 row): both clips' placement, the overlap window and the
    // composition end all lie on the output frame grid, whatever seconds the draft holds. The rounding rule itself is not
    // asserted; only that every planned time is a whole number of output frames.
    it("TG01 places every planned time on the output frame grid", () => {
      const rates = [fps(24), fps(25), fps(30), fps(30000, 1001)];
      fc.assert(fc.property(
        fc.constantFrom(...rates), fc.double({ min: 0, max: 10, noNaN: true }), fc.double({ min: 1, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 10, noNaN: true }), fc.double({ min: 1, max: 10, noNaN: true }), fc.double({ min: 0.1, max: 0.4, noNaN: true }),
        fc.constantFrom("fade" as const, "wipeLeft" as const, "wipeRight" as const),
        (rate, firstIn, firstLength, secondIn, secondLength, share, kind) => {
          const duration = Math.min(firstLength, secondLength) * share;
          const timeline: Clip[] = [
            { ...clips[0]!, in: firstIn, out: firstIn + firstLength, transition: { kind, duration } },
            { ...clips[1]!, in: secondIn, out: secondIn + secondLength },
          ];
          const perSecond = Number(rate.numerator) / Number(rate.denominator);
          const onGrid = (seconds: number): boolean => Math.abs(seconds * perSecond - Math.round(seconds * perSecond)) < 1e-6;
          const plan = api.planVideoTimeline(timeline, rate);
          expect(plan.clips.flatMap((clip) => [clip.start, clip.end, clip.overlap]).every(onGrid) && onGrid(plan.duration)).toBe(true);
        },
      ));
    });
  });
});
