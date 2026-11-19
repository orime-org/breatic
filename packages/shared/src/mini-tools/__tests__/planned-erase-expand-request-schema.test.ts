// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { miniToolExecutionRetryRequestSchema, miniToolPlannedRequestSchema } from "@shared/mini-tools/index.js";

const ids = {
  project: "10000000-0000-4000-8000-000000000001",
  space: "20000000-0000-4000-8000-000000000001",
  source: "30000000-0000-4000-8000-000000000001",
  output: "40000000-0000-4000-8000-000000000001",
  other: "40000000-0000-4000-8000-000000000002",
  run: "50000000-0000-4000-8000-000000000001",
  draft: "60000000-0000-4000-8000-000000000001",
  revision: "70000000-0000-4000-8000-000000000001",
  analysis: "80000000-0000-4000-8000-000000000001",
};
const hash = "a".repeat(64);
const common = {
  project_id: ids.project, space_id: ids.space, run_id: ids.run,
  presentation_ref: { source: { toolInputId: hash, planSha256: "b".repeat(64) } },
};
const source = { nodeId: ids.source, canonicalURL: "https://assets.example.test/video/source.mp4", mediaInfo: { width: 960, height: 540, duration: 5, mimeType: "video/mp4" } };
const draft = (params: Record<string, unknown>): Record<string, unknown> => ({ version: 1, draftId: ids.draft, revision: ids.revision, source, inputs: [], params });
const trackedMask = { version: 1, draftId: ids.draft, toolId: "video.erase", kind: "tracked_mask", analysisRunId: ids.analysis, inputFingerprint: hash };

const ERASE = {
  ...common, tool: "video.erase",
  draft: draft({ range: { start: 0, end: 3 }, anchor: { frameIndex: 0 }, region: { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, points: [] }, trackingPrompt: "" }),
  analysis_refs: [trackedMask],
  outputs: [{ outputIndex: 0, nodeId: ids.output, recipe: { kind: "erase" } }],
};
const EXPAND = {
  ...common, tool: "video.expand",
  draft: draft({ frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: "free", prompt: "" }),
  analysis_refs: [],
  outputs: [{ outputIndex: 0, nodeId: ids.output, recipe: { kind: "expand" } }],
};
const accepted = (value: unknown): boolean => miniToolPlannedRequestSchema.safeParse(value).success;

// Execution design §10.4 and §10.5 request rows: erase names exactly one tracked_mask analysis, expand names none, and
// each has exactly one output carrying its own recipe.
describe("planned erase and expand requests (execution design §10.4, §10.5)", () => {
  it("PE01 accepts an erase over one tracked mask and an expand with no analysis", () => {
    expect(miniToolPlannedRequestSchema.parse(ERASE)).toEqual(ERASE);
    expect(miniToolPlannedRequestSchema.parse(EXPAND)).toEqual(EXPAND);
  });

  it("PE02 refuses an erase without its tracked mask, with two, or with another tool's analysis", () => {
    expect(accepted({ ...ERASE, analysis_refs: [] })).toBe(false);
    expect(accepted({ ...ERASE, analysis_refs: [trackedMask, { ...trackedMask, analysisRunId: "80000000-0000-4000-8000-000000000002" }] })).toBe(false);
    expect(accepted({ ...ERASE, analysis_refs: [{ ...trackedMask, toolId: "video.lip-sync", kind: "people" }] })).toBe(false);
  });

  it("PE03 refuses an expand that names an analysis", () => {
    expect(accepted({ ...EXPAND, analysis_refs: [trackedMask] })).toBe(false);
  });

  it("PE04 refuses a second output or the other tool's recipe", () => {
    for (const body of [ERASE, EXPAND]) {
      expect(accepted({ ...body, outputs: [...body.outputs, { outputIndex: 1, nodeId: ids.other, recipe: body.outputs[0]!.recipe }] })).toBe(false);
    }
    expect(accepted({ ...ERASE, outputs: [{ ...ERASE.outputs[0], recipe: { kind: "expand" } }] })).toBe(false);
    expect(accepted({ ...EXPAND, outputs: [{ ...EXPAND.outputs[0], recipe: { kind: "erase" } }] })).toBe(false);
  });

  it("PE05 a failed erase or expand can be retried as a new execution", () => {
    for (const tool of ["video.erase", "video.expand"]) {
      expect(miniToolExecutionRetryRequestSchema.safeParse({
        tool, project_id: ids.project, space_id: ids.space, run_id: "50000000-0000-4000-8000-000000000002",
        retry: { runId: ids.run, outputIndexes: [0] },
      }).success).toBe(true);
    }
  });
});
