// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §64.4 SC02, SC03, SC05, SC06, SC12 (frames-split design §5.4 上限/派发 rows, §7.1 route table,
 * §10.7, §10.8; execution design §10.2, §10.4, §10.5).
 *
 * - SC02: a carrier identity has sha256 producer/profile versions and `editProfileVersion` (null without an edit file);
 *   the route compares the new job with the latest published version V: reuse the carrier only from a ready selected P
 *   with every version equal; reuse V's edit file when the plan and the edit profile are equal; otherwise encode the edit
 *   file and then the playback file when the job needs one, else encode the playback file. The stage sequence of each
 *   route is checked once, in `packages/ingest/src/__tests__/frame-grid-routes.test.ts`.
 * - SC03: frames and split plan on grid frame numbers; recipes carry frame numbers only.
 * - SC05/SC06: `plannedStageJobs` counts lip-sync `track_join` (one per person), erase `mask` (one), expand window
 *   stages (each window its own stage: window and window_mask, plus frame_at from the second window), and the stage
 *   jobs always sum to the jobs the layout plans.
 * - SC12: erase anchors and ranges are grid frame numbers.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chooseVideoCarrierRoute, plannedStageJobs } from "../video-encode-plan.js";
import { planVideoFrames, planVideoSplit } from "../video-plan.js";
import { miniToolExecutionRecipeSchema } from "../planned-request-schema.js";
import { anchorInTrackingRange, eraseRangeCheck } from "../tracking-clips.js";
import type { FrameRate } from "../../upload/frame-grid-rate.js";

type Window = { start: number; end: number };
type Stage = { stage: string; jobs: number };
/** The contract `VideoCarrierIdentity` (design §10.12 video-encode-plan.ts row); versions are sha256 hex strings. */
interface Identity { planSha256: string; producerVersion: string; profileVersion: string; editProfileVersion: string | null }
interface Grid { fps: FrameRate; frameCount: number }

const PLAN = "a".repeat(64);
const PRODUCER = "b".repeat(64);
const PROFILE = "c".repeat(64);
const EDIT = "d".repeat(64);
const grid = (frameCount: number, numerator = 30, denominator = 1): Grid => ({ fps: { numerator, denominator }, frameCount });
const w = (start: number, end: number): Window => ({ start, end });

// The route input: the new job `plan` and the latest published version V as `reuseFrom` (ready false = V invalid).
const route = chooseVideoCarrierRoute as unknown as (input: { plan: Identity; reuseFrom: { identity: Identity; ready: boolean } | null }) => string;
const stagesOf = plannedStageJobs as unknown as (layout: unknown) => Stage[];
const frames = planVideoFrames as unknown as (grid: Grid, request: { mode: "first" | "last" | "current"; frameIndex?: number }) => unknown[];
const split = planVideoSplit as unknown as (grid: Grid, cuts: readonly number[]) => unknown[];
const inRange = anchorInTrackingRange;
const eraseCheck = eraseRangeCheck as unknown as (grid: Grid, range: Window, anchor: { frameIndex: number }, limits: { minSeconds: number; maxSeconds: number; maxGridFps: number }) => unknown;

const job = (overrides: Partial<Identity> = {}): Identity => ({ planSha256: PLAN, producerVersion: PRODUCER, profileVersion: PROFILE, editProfileVersion: null, ...overrides });

describe("SC02: carrier route from the new job and the latest published version", () => {
  it("SC02: every version equal and the selected P ready reuses the carrier", () => {
    expect(route({ plan: job(), reuseFrom: { identity: job(), ready: true } })).toBe("reuse");
    expect(route({ plan: job({ editProfileVersion: EDIT }), reuseFrom: { identity: job({ editProfileVersion: EDIT }), ready: true } })).toBe("reuse");
  });

  it("SC02: only the playback profile changed: reuse the edit file when there is one, else encode the playback file", () => {
    const changed = "e".repeat(64);
    expect(route({ plan: job({ profileVersion: changed, editProfileVersion: EDIT }), reuseFrom: { identity: job({ editProfileVersion: EDIT }), ready: true } })).toBe("reuse_edit");
    expect(route({ plan: job({ profileVersion: changed }), reuseFrom: { identity: job(), ready: true } })).toBe("encode");
  });

  it("SC02: only FFmpeg changed (producer version): reuse the edit file when there is one, else encode", () => {
    const upgraded = "f".repeat(64);
    expect(route({ plan: job({ producerVersion: upgraded, editProfileVersion: EDIT }), reuseFrom: { identity: job({ editProfileVersion: EDIT }), ready: true } })).toBe("reuse_edit");
    expect(route({ plan: job({ producerVersion: upgraded }), reuseFrom: { identity: job(), ready: true } })).toBe("encode");
  });

  it("SC02: a changed edit profile (presentation.edit.crf) re-encodes the edit file", () => {
    expect(route({ plan: job({ editProfileVersion: "9".repeat(64) }), reuseFrom: { identity: job({ editProfileVersion: EDIT }), ready: true } })).toBe("edit");
  });

  it("SC02: an invalid V (automatic readmit) never reuses the carrier but may reuse its edit file", () => {
    expect(route({ plan: job({ editProfileVersion: EDIT }), reuseFrom: { identity: job({ editProfileVersion: EDIT }), ready: false } })).toBe("reuse_edit");
    expect(route({ plan: job(), reuseFrom: { identity: job(), ready: false } })).toBe("encode");
  });

  it("SC02: a changed plan or no published version encodes from scratch", () => {
    expect(route({ plan: job({ planSha256: "1".repeat(64), editProfileVersion: EDIT }), reuseFrom: { identity: job({ editProfileVersion: EDIT }), ready: true } })).toBe("edit");
    expect(route({ plan: job(), reuseFrom: null })).toBe("encode");
    expect(route({ plan: job({ editProfileVersion: EDIT }), reuseFrom: null })).toBe("edit");
  });
});

describe("SC03: frames and split planned on grid frame numbers", () => {
  it("SC03: first is frame 0, last is frameCount - 1, current is the player's grid frame; one output each, no seconds", () => {
    const g = grid(60);
    expect(frames(g, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0 }]);
    expect(frames(g, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 59 }]);
    expect(frames(g, { mode: "current", frameIndex: 17 })).toEqual([{ outputIndex: 0, frameIndex: 17 }]);
  });

  it("SC03: a current frame outside the grid is refused", () => {
    expect(frames(grid(60), { mode: "current", frameIndex: 59 })).toEqual([{ outputIndex: 0, frameIndex: 59 }]);
    expect(() => frames(grid(60), { mode: "current", frameIndex: 60 })).toThrow();
  });

  it("SC03: cuts are grid frames; 0 and frameCount are dropped, duplicates removed, sorted, N+1 ranges ending at frameCount", () => {
    expect(split(grid(90, 30000, 1001), [60, 0, 30, 90, 30])).toEqual([
      { outputIndex: 0, start: 0, end: 30 },
      { outputIndex: 1, start: 30, end: 60 },
      { outputIndex: 2, start: 60, end: 90 },
    ]);
    expect(split(grid(90), [])).toEqual([{ outputIndex: 0, start: 0, end: 90 }]);
  });

  it("SC03: a fractional or out-of-grid cut is refused", () => {
    expect(split(grid(90), [30, 90])).toHaveLength(2);
    expect(() => split(grid(90), [30.5])).toThrow();
    expect(() => split(grid(90), [91])).toThrow();
  });

  it("SC03: the frame recipe is { kind: 'frame', frameIndex } without seconds; the segment range is grid frames", () => {
    expect(miniToolExecutionRecipeSchema.safeParse({ kind: "frame", frameIndex: 12 }).success).toBe(true);
    expect(miniToolExecutionRecipeSchema.safeParse({ kind: "frame", frameIndex: 12, pts: 0.4 }).success).toBe(false);
    expect(miniToolExecutionRecipeSchema.safeParse({ kind: "segment", range: { start: 30, end: 60 } }).success).toBe(true);
    expect(miniToolExecutionRecipeSchema.safeParse({ kind: "segment", range: { start: 0.5, end: 2.25 } }).success).toBe(false);
  });
});

describe("SC05: plannedStageJobs covers every §5.4 stage", () => {
  it("SC05: lip-sync adds track_join, one job per person, after the tracking preparation", () => {
    const tracking = { forward: [w(30, 90)], reverse: [w(0, 11), w(11, 22), w(22, 31)] };
    expect(stagesOf({ preparation: [w(0, 90)], persons: 2, composite: [w(0, 90)], tracking })).toEqual([
      { stage: "prepare", jobs: 1 }, { stage: "track_prepare", jobs: 4 }, { stage: "track_prepare_stitch", jobs: 1 }, { stage: "track_join", jobs: 2 },
      { stage: "faces", jobs: 2 }, { stage: "clip_stem", jobs: 4 }, { stage: "composite", jobs: 1 }, { stage: "stitch", jobs: 1 },
    ]);
  });

  it("SC05: erase is one prepare job, one mask job (bria_mask), the composite chunks, then one stitch", () => {
    expect(stagesOf({ preparation: [w(0, 60)], composite: [w(0, 30), w(30, 60)] })).toEqual([
      { stage: "prepare", jobs: 1 }, { stage: "mask", jobs: 1 }, { stage: "model_composite", jobs: 2 }, { stage: "stitch", jobs: 1 },
    ]);
  });

  it("SC05: expand sends each window as its own stage (window, window_mask, and frame_at from the second window), then composite and stitch", () => {
    expect(stagesOf({ preparation: [], composite: [w(0, 40), w(40, 80)], windows: 3 })).toEqual([
      { stage: "window", jobs: 2 }, { stage: "window", jobs: 3 }, { stage: "window", jobs: 3 },
      { stage: "model_composite", jobs: 2 }, { stage: "stitch", jobs: 1 },
    ]);
  });
});

/**
 * The container jobs a layout plans, enumerated from the design's dispatch row independently of `plannedStageJobs`.
 * @param layout - A layout of one of the tools.
 * @returns The number of container jobs.
 */
function plannedJobs(layout: Record<string, unknown>): number {
  const count = (key: string): number => (layout[key] as unknown[] | undefined)?.length ?? 0;
  if ("batches" in layout) {
    const encodes = layout.encodes as { chunks: Window[] }[];
    return count("batches") + encodes.reduce((total, encode) => total + encode.chunks.length + 1, 0);
  }
  if ("encode" in layout) return count("encode") + count("window") + 1;
  const preparation = count("preparation") + (count("preparation") > 1 ? 1 : 0);
  if ("persons" in layout) {
    const persons = layout.persons as number;
    const tracking = layout.tracking as { forward: Window[]; reverse: Window[] };
    return preparation + tracking.forward.length + tracking.reverse.length + (tracking.reverse.length > 1 ? 1 : 0)
      + persons /* track_join */ + persons /* faces */ + 2 * persons /* clip, stem */ + count("composite") + 1;
  }
  if ("windows" in layout) {
    const windows = layout.windows as number;
    return windows * 2 + Math.max(0, windows - 1) + count("composite") + 1;
  }
  if ("composite" in layout) return preparation + 1 /* mask */ + count("composite") + 1;
  return preparation;
}

describe("SC06: the stage jobs sum to the planned jobs", () => {
  const windows = (min: number): fc.Arbitrary<Window[]> => fc.array(fc.nat(1000), { minLength: min, maxLength: 6 }).map((starts) => starts.map((start) => w(start, start + 10)));
  const layouts = fc.oneof(
    fc.record({ batches: fc.array(fc.array(fc.nat(9), { minLength: 1, maxLength: 4 }), { maxLength: 4 }), encodes: fc.array(fc.record({ outputIndex: fc.nat(9), chunks: windows(1) }), { maxLength: 3 }) }),
    fc.record({ encode: windows(0), window: windows(0) }),
    fc.record({ preparation: windows(1) }),
    fc.record({ preparation: windows(1).map((list) => list.slice(0, 1)), composite: windows(1) }),
    fc.record({ preparation: fc.constant([] as Window[]), composite: windows(1), windows: fc.integer({ min: 1, max: 5 }) }),
    fc.record({ preparation: windows(1), persons: fc.integer({ min: 1, max: 4 }), composite: windows(1),
      tracking: fc.record({ forward: windows(0).map((list) => list.slice(0, 1)), reverse: windows(0) }) }),
  );

  it("SC06: for every tool's layout, the sum over stages equals the jobs the layout plans", () => {
    fc.assert(fc.property(layouts, (layout) => {
      const stages = stagesOf(layout);
      expect(stages.every((stage) => stage.jobs > 0)).toBe(true);
      expect(stages.reduce((total, stage) => total + stage.jobs, 0)).toBe(plannedJobs(layout as Record<string, unknown>));
    }));
  });
});

describe("SC12: erase anchors and ranges are grid frame numbers", () => {
  it("SC12: the anchor lies in [start, end) of the grid frame range", () => {
    expect(inRange(w(30, 90), { frameIndex: 30 })).toBe(true);
    expect(inRange(w(30, 90), { frameIndex: 89 })).toBe(true);
    expect(inRange(w(30, 90), { frameIndex: 90 })).toBe(false);
    expect(inRange(w(30, 90), { frameIndex: 29 })).toBe(false);
  });

  it("SC12: the erase check reads the grid: frames kept frame for frame at the grid fps, resampled above the eraser's top rate", () => {
    const limits = { minSeconds: 1, maxSeconds: 10, maxGridFps: 30 };
    expect(eraseCheck(grid(300), w(30, 90), { frameIndex: 45 }, limits)).toEqual({ refusal: null, first: 30, count: 60, grid: { mode: "frames", rate: 30, frameCount: 60 } });
    expect(eraseCheck(grid(600, 60), w(60, 180), { frameIndex: 60 }, limits)).toEqual({ refusal: null, first: 60, count: 120, grid: { mode: "resample", rate: 30, frameCount: 60 } });
    expect(eraseCheck(grid(300), w(30, 90), { frameIndex: 90 }, limits)).toEqual({ refusal: "anchor" });
    expect(eraseCheck(grid(300), w(30, 45), { frameIndex: 30 }, limits)).toEqual({ refusal: "range" });
  });
});
