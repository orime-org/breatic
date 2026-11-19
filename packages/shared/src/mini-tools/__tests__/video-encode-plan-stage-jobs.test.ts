// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 item 2 (frames-split §5.4 上限/预算 rows; D11-2, D12-1): the frozen layout, now a union by tool
 * in shared `video-encode-plan.ts`, is the single input `plannedStageJobs` counts per stage, in execution order, zero-job
 * stages omitted. Admission compares the largest stage with `max_parallel_chunks`. Read from the mini-tools entry by name
 * so this compiles before the function exists.
 */
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type Window = { start: number; end: number };
type Stage = { stage: string; jobs: number };
const api = miniTools as unknown as { plannedStageJobs: (layout: unknown) => Stage[] };
const w = (start: number, end: number): Window => ({ start, end });
const max = (stages: Stage[]): number => Math.max(...stages.map((stage) => stage.jobs));

describe("stage job counts of a frozen layout (§97 D12-1)", () => {
  it("SJ01 frames/split: encode is batches plus every chunk, stitch one per chunked output", () => {
    const layout = { batches: [[0, 1], [2]], encodes: [{ outputIndex: 3, chunks: [w(0, 10), w(10, 20), w(20, 30)] }, { outputIndex: 4, chunks: [w(0, 5), w(5, 9)] }] };
    expect(api.plannedStageJobs(layout)).toEqual([{ stage: "encode", jobs: 7 }, { stage: "stitch", jobs: 2 }]);
  });

  it("SJ02 frames/split without chunked outputs has no stitch stage", () => {
    expect(api.plannedStageJobs({ batches: [[0, 1, 2]], encodes: [] })).toEqual([{ stage: "encode", jobs: 1 }]);
  });

  it("SJ03 remove-bg: prepare per chunk, and one prepare stitch only when the preparation is chunked", () => {
    expect(api.plannedStageJobs({ preparation: [w(0, 50)] })).toEqual([{ stage: "prepare", jobs: 1 }]);
    expect(api.plannedStageJobs({ preparation: [w(0, 50), w(50, 90)] })).toEqual([{ stage: "prepare", jobs: 2 }, { stage: "prepare_stitch", jobs: 1 }]);
  });

  // frames-split §5.4 上限 row: erase makes its mask (`bria_mask`) after the preparation; expand's windows are in frame-grid-plan.test.ts.
  it("SJ04 erase: prepare, prepare stitch, mask, model_composite per composite chunk, then one stitch", () => {
    expect(api.plannedStageJobs({ preparation: [w(0, 40), w(40, 80)], composite: [w(0, 30), w(30, 60), w(60, 80)] }))
      .toEqual([{ stage: "prepare", jobs: 2 }, { stage: "prepare_stitch", jobs: 1 }, { stage: "mask", jobs: 1 }, { stage: "model_composite", jobs: 3 }, { stage: "stitch", jobs: 1 }]);
  });

  it("SJ05 transitions: encode is the encode chunks plus the window chunks, then one stitch", () => {
    expect(api.plannedStageJobs({ encode: [w(0, 48), w(60, 120)], window: [w(48, 60)] })).toEqual([{ stage: "encode", jobs: 3 }, { stage: "stitch", jobs: 1 }]);
  });

  // §97 D13 (frames-split §5.4 派发 row): a Cut has no overlap window, so no transition_window job is sent.
  it("SJ08 transitions with a Cut: no window chunks, so encode counts only the encode chunks", () => {
    expect(api.plannedStageJobs({ encode: [w(0, 48), w(48, 120)], window: [] })).toEqual([{ stage: "encode", jobs: 2 }, { stage: "stitch", jobs: 1 }]);
  });

  it("SJ06 lip-sync: two people, one unchunked preparation and one composite chunk need at most four jobs at once", () => {
    const stages = api.plannedStageJobs({ preparation: [w(0, 90)], persons: 2, composite: [w(0, 90)], tracking: { forward: [], reverse: [] } });
    // frames-split §5.4 上限 row: each person's track_join is its own job.
    expect(stages).toEqual([{ stage: "prepare", jobs: 1 }, { stage: "track_join", jobs: 2 }, { stage: "faces", jobs: 2 }, { stage: "clip_stem", jobs: 4 }, { stage: "composite", jobs: 1 }, { stage: "stitch", jobs: 1 }]);
    expect(max(stages)).toBe(4);
  });

  // Execution design §10.2: the tracking clips are prepared side by side, prepare:fwd and every reversed chunk of prepare:rev
  // at once, and the reversed chunks are then stitched; each is a container job the cap and the quote count.
  it("SJ09 lip-sync: prepare:fwd and the reversed clip's chunks are one stage, their stitch the next", () => {
    const tracking = { forward: [w(30, 90)], reverse: [w(0, 11), w(11, 22), w(22, 31)] };
    expect(api.plannedStageJobs({ preparation: [w(0, 90)], persons: 1, composite: [w(0, 90)], tracking }))
      .toEqual([{ stage: "prepare", jobs: 1 }, { stage: "track_prepare", jobs: 4 }, { stage: "track_prepare_stitch", jobs: 1 }, { stage: "track_join", jobs: 1 }, { stage: "faces", jobs: 1 },
        { stage: "clip_stem", jobs: 2 }, { stage: "composite", jobs: 1 }, { stage: "stitch", jobs: 1 }]);
    // A reversed clip in one job is not stitched; a clip the preparation itself is sends none.
    expect(api.plannedStageJobs({ preparation: [w(0, 90)], persons: 1, composite: [w(0, 90)], tracking: { forward: [], reverse: [w(0, 31)] } }))
      .toContainEqual({ stage: "track_prepare", jobs: 1 });
    expect(api.plannedStageJobs({ preparation: [w(0, 90)], persons: 1, composite: [w(0, 90)], tracking: { forward: [], reverse: [w(0, 31)] } }).map((stage) => stage.stage))
      .not.toContain("track_prepare_stitch");
  });

  it("SJ07 a split whose total jobs exceed a cap of four has a largest stage within it", () => {
    const stages = api.plannedStageJobs({ batches: [[0]], encodes: [{ outputIndex: 1, chunks: [w(0, 10), w(10, 20)] }, { outputIndex: 2, chunks: [w(0, 10)] }] });
    expect(stages).toEqual([{ stage: "encode", jobs: 4 }, { stage: "stitch", jobs: 2 }]);
    expect(stages.reduce((sum, stage) => sum + stage.jobs, 0)).toBeGreaterThan(4);
    expect(max(stages)).toBeLessThanOrEqual(4);
  });
});
