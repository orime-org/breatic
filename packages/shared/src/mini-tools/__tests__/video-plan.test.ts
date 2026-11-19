// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface Dialogue { dialogueId: string; personId: string; audioInputId: string; startTime: number; duration: number }
type SyncMode = "cut_off" | "silence" | "loop" | "bounce" | "remap";
interface Clip { clipId: string; inputId: string; in: number; out: number; transition: { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number } }
// §97 D15-3: the frame-grid timeline, every number a whole count of output frames; seconds are derived by callers.
interface PlannedClip { clipId: string; inputId: string; startFrame: number; frameCount: number; inFrame: number; outFrame: number }
interface FrameTimeline { fps: Rational; frameCount: number; clips: PlannedClip[]; window: { startFrame: number; frameCount: number; kind: "fade" | "wipeLeft" | "wipeRight" } | null }
interface PlanApi {
  chunkVideoOutputs: <T>(outputs: readonly T[], chunkSize: number) => T[][];
  planVideoDialogues: (input: { videoDuration: number; dialogues: readonly Dialogue[]; syncMode: SyncMode }) => { duration: number; dialogues: Dialogue[] };
  // §97 D12-2, D13-2: the timeline planner takes the output frame rate as the plan's exact rational and plans on its grid.
  planVideoTimeline: (clips: readonly Clip[], fps: Rational) => FrameTimeline;
  timelineClipLacksOutputFrame: (clip: Pick<Clip, "in" | "out">, fps: Rational) => boolean;
}
type Rational = { numerator: number; denominator: number };
const fps = (numerator: number, denominator = 1): Rational => ({ numerator, denominator });
// The earlier seconds all lie on the 30 fps grid; the four migrated cases assert the same placement in frames (4.4.5).
const FPS30 = fps(30);
/**
 * The nearest whole frame, a tie going down (§97 D15-3).
 * @param frames - A frame position.
 * @returns The snapped frame.
 */
const nearest = (frames: number): number => Math.ceil(frames - 0.5);

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
    expect(["planVideoFrames", "planVideoSplit", "chunkVideoOutputs", "planVideoDialogues", "planVideoTimeline"].filter((key) => !(key in miniTools))).toEqual([]);
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
    // §97 D15-3 (4.4.5, contract changed): the earlier seconds 0–3, 2.5–6.5, overlap 0.5 and end 6.5 in 30 fps frames.
    it("places the second trimmed clip at the shared overlap boundary", () => {
      expect(api.planVideoTimeline(clips, FPS30)).toEqual({ fps: FPS30, frameCount: 195, window: { startFrame: 75, frameCount: 15, kind: "fade" }, clips: [
        { clipId: clips[0]!.clipId, inputId: clips[0]!.inputId, startFrame: 0, frameCount: 90, inFrame: 30, outFrame: 120 },
        { clipId: clips[1]!.clipId, inputId: clips[1]!.inputId, startFrame: 75, frameCount: 120, inFrame: 60, outFrame: 180 },
      ] });
    });

    it("finds a trimmed clip that snaps to no output frame, a tie going down", () => {
      expect(api.timelineClipLacksOutputFrame({ in: 0, out: 0.01 }, FPS30)).toBe(true);
      expect(api.timelineClipLacksOutputFrame({ in: 0, out: 1 / 60 }, FPS30)).toBe(true);
      expect(api.timelineClipLacksOutputFrame({ in: 0, out: 0.02 }, FPS30)).toBe(false);
      expect(() => api.planVideoTimeline([{ ...clips[0]!, in: 1, out: 1.01 }, clips[1]!], FPS30)).toThrow(RangeError);
    });

    it("keeps source identity independent for repeated uses of one input", () => {
      const repeated = [clips[0]!, { ...clips[1]!, inputId: clips[0]!.inputId }];
      const plan = api.planVideoTimeline(repeated, FPS30);
      expect(plan.clips.map((clip) => [clip.clipId, clip.inputId, clip.inFrame, clip.outFrame, clip.startFrame])).toEqual([
        [clips[0]!.clipId, clips[0]!.inputId, 30, 120, 0],
        [clips[1]!.clipId, clips[0]!.inputId, 60, 180, 75],
      ]);
      expect(plan.frameCount).toBe(195);
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

    // §97 D15-3 (frames-split §7.17 转场输出档 row, §5.4 切块 row): in, out and the transition duration snap to the nearest
    // output frame, a tie going down; the transition lasts at least one frame; the window starts at the first clip's end
    // frame minus its frame count, where the second clip starts; a Cut has no window.
    it.each([
      ["a 0.1 s fade at 24 fps is 2.4 frames, so 2", { in: 0, out: 2, transition: { kind: "fade" as const, duration: 0.1 } }, { inFrame: 0, outFrame: 48 }, 2],
      ["a 0.0625 s fade at 24 fps is a 1.5-frame tie, so 1", { in: 0, out: 2, transition: { kind: "wipeLeft" as const, duration: 0.0625 } }, { inFrame: 0, outFrame: 48 }, 1],
      ["a 0.01 s fade is at least one frame", { in: 0, out: 2, transition: { kind: "wipeRight" as const, duration: 0.01 } }, { inFrame: 0, outFrame: 48 }, 1],
      ["in and out at ties go down, others to the nearest", { in: 0.0625, out: 2.03, transition: { kind: "fade" as const, duration: 0.25 } }, { inFrame: 1, outFrame: 49 }, 6],
      ["out at a tie goes down", { in: 0.05, out: 1.0625, transition: { kind: "fade" as const, duration: 0.25 } }, { inFrame: 1, outFrame: 25 }, 6],
    ])("TG01 %s", (_name, first, snapped, windowFrames) => {
      const plan = api.planVideoTimeline([{ ...clips[0]!, ...first }, { ...clips[1]!, in: 0, out: 2 }], fps(24));
      const length = snapped.outFrame - snapped.inFrame;
      expect(plan.clips[0]).toEqual({ clipId: clips[0]!.clipId, inputId: clips[0]!.inputId, startFrame: 0, frameCount: length, ...snapped });
      expect(plan.window).toEqual({ startFrame: length - windowFrames, frameCount: windowFrames, kind: first.transition.kind });
      expect(plan.clips[1]).toMatchObject({ startFrame: length - windowFrames, inFrame: 0, outFrame: 48, frameCount: 48 });
      expect(plan.frameCount).toBe(length - windowFrames + 48);
    });

    it("TG02 a Cut has no window and the second clip starts where the first ends", () => {
      const plan = api.planVideoTimeline([{ ...clips[0]!, transition: { kind: "cut", duration: 0 } }, clips[1]!], FPS30);
      expect(plan.window).toBeNull();
      expect(plan.clips.map((clip) => clip.startFrame)).toEqual([0, 90]);
      expect(plan.frameCount).toBe(210);
    });

    it("TG03 every field is a whole frame count consistent with the snapped draft, for any rate", () => {
      const rates = [fps(24), fps(25), fps(30), fps(30000, 1001)];
      fc.assert(fc.property(
        fc.constantFrom(...rates), fc.double({ min: 0, max: 10, noNaN: true }), fc.double({ min: 1, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 10, noNaN: true }), fc.double({ min: 1, max: 10, noNaN: true }), fc.double({ min: 0, max: 0.4, noNaN: true }),
        fc.constantFrom("cut" as const, "fade" as const, "wipeLeft" as const, "wipeRight" as const),
        (rate, firstIn, firstLength, secondIn, secondLength, share, kind) => {
          const duration = kind === "cut" ? 0 : Math.max(Math.min(firstLength, secondLength) * share, 0.05);
          const draft: Clip[] = [
            { ...clips[0]!, in: firstIn, out: firstIn + firstLength, transition: { kind, duration } },
            { ...clips[1]!, in: secondIn, out: secondIn + secondLength },
          ];
          const perSecond = Number(rate.numerator) / Number(rate.denominator);
          const plan = api.planVideoTimeline(draft, rate);
          const [a, b] = plan.clips as [PlannedClip, PlannedClip];
          const numbers = [plan.frameCount, ...plan.clips.flatMap((clip) => [clip.startFrame, clip.frameCount, clip.inFrame, clip.outFrame]), ...(plan.window ? [plan.window.startFrame, plan.window.frameCount] : [])];
          expect(numbers.every((value) => Number.isSafeInteger(value) && value >= 0)).toBe(true);
          expect(plan.fps).toEqual(rate);
          draft.forEach((clip, at) => {
            expect(Math.abs(plan.clips[at]!.inFrame - clip.in * perSecond)).toBeLessThanOrEqual(0.5 + 1e-9);
            expect(Math.abs(plan.clips[at]!.outFrame - clip.out * perSecond)).toBeLessThanOrEqual(0.5 + 1e-9);
            expect(plan.clips[at]!.frameCount).toBe(plan.clips[at]!.outFrame - plan.clips[at]!.inFrame);
          });
          expect(a.startFrame).toBe(0);
          if (kind === "cut") {
            expect(plan.window).toBeNull();
            expect(b.startFrame).toBe(a.frameCount);
          } else {
            expect(plan.window).toEqual({ startFrame: a.frameCount - plan.window!.frameCount, frameCount: Math.max(1, nearest(duration * perSecond)), kind });
            expect(b.startFrame).toBe(plan.window!.startFrame);
          }
          expect(plan.frameCount).toBe(b.startFrame + b.frameCount);
        },
      ));
    });
  });
});
