// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  hashMiniToolValue,
  miniToolPlannedRequestSchema,
  miniToolRequestSchema,
  miniToolSubmissionSchema,
  videoToolAnalysisRefs,
  type MiniToolPlannedRequest,
  type MiniToolRequest,
  type MiniToolSubmission,
  type VideoToolAnalysisRef,
} from "@shared/mini-tools/index.js";

// inner#1306: the independent HTTP contract supplies this complete literal and digest.
const BODY: MiniToolPlannedRequest = {
  tool: "video.focus-crop",
  project_id: "10000000-0000-4000-8000-000000000001",
  space_id: "20000000-0000-4000-8000-000000000001",
  run_id: "50000000-0000-4000-8000-000000000001",
  draft: {
    version: 1,
    draftId: "60000000-0000-4000-8000-000000000001",
    revision: "70000000-0000-4000-8000-000000000001",
    source: {
      nodeId: "30000000-0000-4000-8000-000000000001",
      canonicalURL: "https://assets.example.test/video/source.mp4",
      mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" },
    },
    inputs: [],
    params: { frameIndex: 12, crop: { x: 10, y: 20, width: 300, height: 200 }, sourceName: "clip" },
  },
  analysis_refs: [],
  outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "frame", frameIndex: 12, crop: { x: 10, y: 20, width: 300, height: 200 } } }],
  // S6e E3-1 (inner#1306 §90): every video tool request names its tool input; the digest was recomputed with Python.
  presentation_ref: { source: { toolInputId: "e989392b50af768e7d1a42bdf29921f364c87e90bdb34ddc633209ffe22a19ec", planSha256: "bf04fa15ca5b369ad3012912dacce70ff0ec47c9779c5c1f87e461505e3c4ea1" } },
};
const BODY_HASH = "1544517960125b7b00fab2fa65f831ec121e3a67fbed40b592b0d016a7b2edd5";

const LEGACY_MODEL: MiniToolRequest = {
  tool: "image.remove-bg",
  project_id: BODY.project_id,
  space_id: BODY.space_id,
  node_ids: [BODY.outputs[0]!.nodeId],
  source: { url: "https://assets.example.test/image/source.png" },
  params: {},
  slots: {},
};
const LEGACY_CONTAINER: MiniToolRequest = {
  tool: "audio.cut",
  project_id: BODY.project_id,
  space_id: BODY.space_id,
  node_ids: [BODY.outputs[0]!.nodeId],
  source: { url: "https://assets.example.test/audio/source.m4a", duration: 12 },
  params: { range: { start: 1, end: 3 } },
  slots: {},
};
const REFERENCE: VideoToolAnalysisRef = {
  version: 1,
  draftId: BODY.draft.draftId,
  toolId: "video.split",
  kind: "scene_cuts",
  analysisRunId: "90000000-0000-4000-8000-000000000001",
  inputFingerprint: "a".repeat(64),
};

/** Removes one required property without filling it from the schema. @throws {never} Never. */
function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy;
}

/** Checks a domain-value rejection without asserting an HTTP wrapper. @throws {Error} On an unexpected parse result. */
function expectValueRejection(value: unknown): void {
  const result = miniToolPlannedRequestSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected the planned value to be rejected");
  const issues = result.error.issues.filter((issue) => issue.code === "custom");
  expect(issues.map((issue) => issue.code)).toContain("custom");
  for (const issue of issues) expect(issue.params?.requestShape).not.toBe(true);
}

describe("planned video submission schema", () => {
  it("H01 preserves the complete literal draft and indexed public recipe", () => {
    const parsed: MiniToolPlannedRequest = miniToolPlannedRequestSchema.parse(BODY);
    expect(parsed).toEqual(BODY);
    const submission: MiniToolSubmission = miniToolSubmissionSchema.parse(BODY);
    expect(submission).toEqual(BODY);
    expect(miniToolRequestSchema.safeParse(BODY).success).toBe(false);
  });

  it("keeps the independently supplied canonical whole-body hash", async () => {
    expect(await hashMiniToolValue(BODY)).toBe(BODY_HASH);
    const reordered = {
      presentation_ref: (BODY as { presentation_ref: unknown }).presentation_ref,
      outputs: BODY.outputs,
      analysis_refs: BODY.analysis_refs,
      draft: { params: BODY.draft.params, inputs: [], source: BODY.draft.source, revision: BODY.draft.revision, draftId: BODY.draft.draftId, version: 1 },
      run_id: BODY.run_id,
      space_id: BODY.space_id,
      project_id: BODY.project_id,
      tool: BODY.tool,
    };
    expect(await hashMiniToolValue(reordered)).toBe(BODY_HASH);
  });

  it.each<keyof MiniToolPlannedRequest>(["tool", "project_id", "space_id", "run_id", "draft", "analysis_refs", "outputs"])("H02 requires outer field %s", (key) => {
    const candidate = without(BODY, key);
    expect(miniToolPlannedRequestSchema.safeParse(candidate).success).toBe(false);
    expect(miniToolSubmissionSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(["project_id", "space_id", "run_id"])("H02 rejects a malformed %s UUID", (field) => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, [field]: "not-a-uuid" }).success).toBe(false);
  });

  it("H03 rejects the legacy-shaped body for a planned tool", () => {
    const oldShape = {
      tool: "video.focus-crop", project_id: BODY.project_id, space_id: BODY.space_id,
      node_ids: [BODY.outputs[0]!.nodeId], source: { url: BODY.draft.source.canonicalURL }, params: {}, slots: {},
    };
    expect(miniToolPlannedRequestSchema.safeParse(oldShape).success).toBe(false);
    expect(miniToolSubmissionSchema.safeParse(oldShape).success).toBe(false);
  });

  it("H04 refuses an unsupported draft version instead of rebuilding it", () => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, draft: { ...BODY.draft, version: 2 } }).success).toBe(false);
  });

  it.each<keyof MiniToolPlannedRequest["draft"]>(["draftId", "revision", "source", "inputs", "params"])("H04 requires draft field %s", (field) => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, draft: without(BODY.draft, field) }).success).toBe(false);
  });

  it.each(["draftId", "revision"])("H04 rejects a malformed draft %s UUID", (field) => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, draft: { ...BODY.draft, [field]: "not-a-uuid" } }).success).toBe(false);
  });

  it.each([
    { anchor: { frameIndex: 0, pts: 0 } },
    { argv: ["ffmpeg", "-version"] },
    { model: "another-model" },
  ])("H04 refuses undeclared focus crop params %j", (params) => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, draft: { ...BODY.draft, params: { ...BODY.draft.params, ...params } } }).success).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("H05 rejects invalid output index %s", (outputIndex) => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, outputs: [{ ...BODY.outputs[0], outputIndex }] }).success).toBe(false);
  });

  it("H05 requires the target node UUID", () => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, outputs: [{ ...BODY.outputs[0], nodeId: "not-a-uuid" }] }).success).toBe(false);
  });

  it.each([
    {},
    { kind: "frame" },
    { kind: "frame", frameIndex: 12, crop: { x: 10, y: 20, width: 300, height: 200 }, argv: ["ffmpeg", "-version"] },
    { kind: "frame", frameIndex: 12, crop: { x: 10, y: 20, width: 300, height: 200 }, model: "another-model" },
    { kind: "frame", frameIndex: 12, crop: { x: 10, y: 20, width: 300, height: 200 }, schemaVersion: 2 },
  ])("H05 rejects a non-public or widened recipe %j", (recipe) => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, outputs: [{ ...BODY.outputs[0], recipe }] }).success).toBe(false);
  });

  it.each([
    { name: "no output", outputs: [] },
    { name: "two different outputs", outputs: [BODY.outputs[0], { ...BODY.outputs[0], outputIndex: 1, nodeId: "40000000-0000-4000-8000-000000000002" }] },
    { name: "duplicate index", outputs: [BODY.outputs[0], { ...BODY.outputs[0], nodeId: "40000000-0000-4000-8000-000000000002" }] },
    { name: "duplicate target", outputs: [BODY.outputs[0], { ...BODY.outputs[0], outputIndex: 1 }] },
  ])("H06 rejects $name as a value error", ({ outputs }) => {
    expectValueRejection({ ...BODY, outputs });
  });

  it("H06 rejects positive nonzero output indices as value errors", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (outputIndex) => {
      expectValueRejection({ ...BODY, outputs: [{ ...BODY.outputs[0], outputIndex }] });
    }));
  });

  it("H07 refuses the source node as the output without marking the request structurally old", () => {
    expectValueRejection({ ...BODY, outputs: [{ ...BODY.outputs[0], nodeId: BODY.draft.source.nodeId }] });
  });

  it("H08 preserves valid client-declared media values for the domain resolver to judge", () => {
    const candidate = {
      ...BODY,
      draft: { ...BODY.draft, source: { ...BODY.draft.source, mediaInfo: { width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" } } },
    };
    expect(miniToolPlannedRequestSchema.parse(candidate)).toEqual(candidate);
  });

  it("H10 constructs the normal empty-ref request after selecting this tool's node references", () => {
    const nodeData = {
      [`miniToolAnalysis:${REFERENCE.analysisRunId}`]: REFERENCE,
      "miniToolAnalysis:90000000-0000-4000-8000-000000000002": {
        ...REFERENCE, analysisRunId: "90000000-0000-4000-8000-000000000002", kind: "unknown",
      },
      "miniToolAnalysis:90000000-0000-4000-8000-000000000003": {
        ...REFERENCE, analysisRunId: "90000000-0000-4000-8000-000000000003",
      },
    };
    const references = videoToolAnalysisRefs(nodeData);
    expect(references.map((reference) => reference.kind)).toEqual(["scene_cuts", "scene_cuts"]);
    const tool: string = BODY.tool;
    const selected = references.filter((reference) => reference.toolId === tool);
    expect(selected).toEqual([]);
    expect(miniToolPlannedRequestSchema.parse({ ...BODY, analysis_refs: selected })).toEqual(BODY);
  });

  it("preserves valid additional references without inventing a zero-count cap", () => {
    const candidate = { ...BODY, analysis_refs: [REFERENCE] };
    expect(miniToolPlannedRequestSchema.parse(candidate)).toEqual(candidate);
  });

  it("still validates additional references against their existing typed shape", () => {
    expect(miniToolPlannedRequestSchema.safeParse({ ...BODY, analysis_refs: [{ ...REFERENCE, analysisRunId: "not-a-uuid" }] }).success).toBe(false);
  });
});

describe("legacy submissions retain their original request contract", () => {
  it.each([LEGACY_MODEL, LEGACY_CONTAINER])("accepts $tool through both legacy and eventual submission schemas", (body) => {
    const legacy: MiniToolRequest = miniToolRequestSchema.parse(body);
    expect(legacy).toEqual(body);
    const submission: MiniToolSubmission = miniToolSubmissionSchema.parse(body);
    expect(submission).toEqual(body);
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([LEGACY_MODEL, LEGACY_CONTAINER])("preserves the node-count refusal for $tool", (body) => {
    expect(miniToolRequestSchema.safeParse({ ...body, node_ids: [] }).success).toBe(false);
    expect(miniToolSubmissionSchema.safeParse({ ...body, node_ids: [] }).success).toBe(false);
  });
});
