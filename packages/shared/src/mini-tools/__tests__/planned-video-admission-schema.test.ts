// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { miniToolPlannedRequestSchema, miniToolSubmissionSchema } from "../planned-request-schema.js";

const RUN = "50000000-0000-4000-8000-000000000001";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const NODES = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"];
const receipt = {
  schemaVersion: 2, sourceFingerprint: "a".repeat(64), producerVersion: 2,
  attempt: { jobId: "original-table-job", deadlineAt: 7201000 },
  url: "https://assets.example.test/source.mp4.video-source-ledger.v2.json", etag: "original-etag",
  size: 512, sha256: "b".repeat(64), contentType: "application/json",
  table: { url: "https://assets.example.test/source.mp4.table.json", size: 128, sha256: "c".repeat(64), frameCount: 3 },
};

/** Build a complete wire request without depending on the missing admission implementation. @throws {never} Never. */
function request(tool: "video.extract-frames" | "video.split" = "video.extract-frames"): Record<string, unknown> {
  return {
    tool, project_id: "10000000-0000-4000-8000-000000000001", space_id: "20000000-0000-4000-8000-000000000001", run_id: RUN,
    draft: { version: 1, draftId: "60000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000001",
      source: { nodeId: SOURCE, canonicalURL: "https://assets.example.test/source.mp4", mediaInfo: { width: 960, height: 540, duration: 5, mimeType: "video/mp4" } },
      inputs: [], params: tool === "video.split" ? { cuts: [3], sensitivity: 27 } : { mode: "first", currentTime: 2, interval: 1 } },
    analysis_refs: [], source_ledger: structuredClone(receipt),
    outputs: tool === "video.split"
      ? [{ outputIndex: 0, nodeId: NODES[0], recipe: { kind: "segment", range: { start: 2, end: 3 } } }, { outputIndex: 1, nodeId: NODES[1], recipe: { kind: "segment", range: { start: 3, end: 5 } } }]
      : [{ outputIndex: 0, nodeId: NODES[0], recipe: { kind: "frame", frameIndex: 0, pts: 2 } }],
  };
}

/** Build the retry wire shape: no current draft or replacement output mapping. @throws {never} Never. */
function retry(): Record<string, unknown> {
  return { tool: "video.split", project_id: "10000000-0000-4000-8000-000000000001", space_id: "20000000-0000-4000-8000-000000000001",
    run_id: "50000000-0000-4000-8000-000000000002", retry: { runId: RUN, outputIndexes: [1] } };
}

/** Replace a JSON path in a cloned request, leaving the valid control untouched. @throws {Error} When the fixture path is wrong. */
function changed(body: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const clone = structuredClone(body);
  const parts = path.split(".");
  let parent: object = clone;
  for (const part of parts.slice(0, -1)) {
    const next: unknown = Reflect.get(parent, part);
    if (typeof next !== "object" || next === null) throw new Error(`Invalid fixture path ${path}`);
    parent = next;
  }
  if (value === undefined) Reflect.deleteProperty(parent, parts.at(-1)!);
  else Reflect.set(parent, parts.at(-1)!, value);
  return clone;
}

describe("S5 planned frame and segment request contracts", () => {
  it.each(["first", "last", "current", "interval"])("S5-Q01 accepts complete %s frame selection without stripping its receipt or recipe", (mode) => {
    const body = changed(request(), "draft.params.mode", mode);
    expect(miniToolPlannedRequestSchema.parse(body)).toEqual(body);
    expect(miniToolSubmissionSchema.parse(body)).toEqual(body);
  });
  it("S5-Q01 accepts every segment mapping and its nonzero origin", () => {
    const body = request("video.split");
    expect(miniToolPlannedRequestSchema.parse(body)).toEqual(body);
    expect(miniToolSubmissionSchema.parse(body)).toEqual(body);
  });
  it.each([
    ["outputs.0.recipe.frameIndex", -1], ["outputs.0.recipe.frameIndex", 0.5], ["outputs.0.recipe.frameIndex", Number.MAX_SAFE_INTEGER + 1],
    ["outputs.0.recipe.pts", -1], ["outputs.0.recipe.pts", Number.NaN], ["outputs.0.recipe.pts", Number.POSITIVE_INFINITY],
    ["outputs.0.recipe.frameIndex", undefined], ["outputs.0.recipe.pts", undefined], ["outputs.0.recipe.kind", "remove-bg"],
    ["outputs.0.recipe.argv", ["-i", "untrusted"]], ["outputs.0.nodeId", SOURCE], ["outputs.0.outputIndex", -1],
    ["outputs.0.outputIndex", 0.5], ["outputs", []], ["source_ledger", undefined], ["source_ledger.sourceFingerprint", "wrong"],
    ["source_ledger.sha256", "wrong"], ["source_ledger.table.sha256", "wrong"], ["source_ledger.table.frameCount", 0],
    ["source_ledger.table.size", 0], ["source_ledger.table.extra", true], ["source_ledger.schemaVersion", 1], ["provider", "cloudflare"],
  ])("S5-Q02 refuses invalid frame field %s=%s only after accepting its valid control", (path, value) => {
    const body = request();
    expect(miniToolPlannedRequestSchema.parse(body)).toEqual(body);
    expect(miniToolPlannedRequestSchema.safeParse(changed(body, String(path), value)).success).toBe(false);
  });
  it.each([
    ["outputs.0.recipe.range.start", -1], ["outputs.0.recipe.range.start", 3], ["outputs.0.recipe.range.start", 4],
    ["outputs.0.recipe.range.end", Number.POSITIVE_INFINITY], ["outputs.0.recipe.range.end", undefined],
    ["outputs.0.recipe.range.extra", 1], ["outputs.0.recipe.frameIndex", 0], ["outputs.1.outputIndex", 0],
    ["outputs.1.nodeId", NODES[0]], ["outputs.1.nodeId", SOURCE],
  ])("S5-Q02 refuses invalid segment field %s=%s after accepting its valid control", (path, value) => {
    const body = request("video.split");
    expect(miniToolPlannedRequestSchema.parse(body)).toEqual(body);
    expect(miniToolPlannedRequestSchema.safeParse(changed(body, String(path), value)).success).toBe(false);
  });
  it("S5-Q03 preserves planned remove-bg without a frame receipt", () => {
    const body = changed(request(), "tool", "video.remove-bg");
    const removal = changed(changed(changed(body, "draft.params", {}), "outputs.0.recipe", { kind: "remove-bg" }), "source_ledger", undefined);
    expect(miniToolPlannedRequestSchema.parse(removal)).toEqual(removal);
    expect(miniToolSubmissionSchema.parse(removal)).toEqual(removal);
  });
  it("S5-Q03 preserves the legacy container cut contract", () => {
    const body = { tool: "video.cut", project_id: "10000000-0000-4000-8000-000000000001", space_id: "20000000-0000-4000-8000-000000000001",
      node_ids: [NODES[0]], source: { url: "https://assets.example.test/source.mp4" }, params: { range: { start: 1, end: 3 } }, slots: {} };
    expect(miniToolSubmissionSchema.parse(body)).toEqual(body);
  });
  it("S5-Q04 accepts a new execution selecting original failed output identities", () => {
    expect(miniToolSubmissionSchema.parse(retry())).toEqual(retry());
  });
  it.each([
    ["retry.outputIndexes", []], ["retry.outputIndexes", [1, 1]], ["retry.outputIndexes", [-1]], ["retry.outputIndexes", [0.5]],
    ["retry.outputIndexes", [Number.MAX_SAFE_INTEGER + 1]], ["retry.runId", "invalid"], ["retry.runId", undefined],
    ["run_id", RUN], ["draft", request().draft], ["outputs", request().outputs], ["source_ledger", receipt], ["retry.recipe", { kind: "segment" }],
  ])("S5-Q04 refuses invalid retry field %s=%s after accepting its valid control", (path, value) => {
    const body = retry();
    expect(miniToolSubmissionSchema.parse(body)).toEqual(body);
    expect(miniToolSubmissionSchema.safeParse(changed(body, String(path), value)).success).toBe(false);
  });
  it("S5-Q04 preserves arbitrary unique output IDs through the retry wire without accepting duplicates", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }), (ids) => {
      const body = changed(retry(), "retry.outputIndexes", ids);
      expect(miniToolSubmissionSchema.parse(body)).toEqual(body);
      expect(miniToolSubmissionSchema.safeParse(changed(body, "retry.outputIndexes", [...ids, ids[0]])).success).toBe(false);
    }), { seed: 130605, numRuns: 32 });
  });
});
