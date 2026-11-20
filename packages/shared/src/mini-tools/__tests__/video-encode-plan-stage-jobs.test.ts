// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 item 2 (frames-split §5.4 上限/预算 rows; D11-2, D12-1): the frozen layout in shared
 * `video-encode-plan.ts` is the single input `plannedStageJobs` counts per stage, in execution order, zero-job
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

  it("SJ07 a split whose total jobs exceed a cap of four has a largest stage within it", () => {
    const stages = api.plannedStageJobs({ batches: [[0]], encodes: [{ outputIndex: 1, chunks: [w(0, 10), w(10, 20)] }, { outputIndex: 2, chunks: [w(0, 10)] }] });
    expect(stages).toEqual([{ stage: "encode", jobs: 4 }, { stage: "stitch", jobs: 2 }]);
    expect(stages.reduce((sum, stage) => sum + stage.jobs, 0)).toBeGreaterThan(4);
    expect(max(stages)).toBeLessThanOrEqual(4);
  });
});
