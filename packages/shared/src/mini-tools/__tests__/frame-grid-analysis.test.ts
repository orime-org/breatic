// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §64.4 SC12 (frames-split design §10.12 analysis-input.ts, analysis-record.ts rows; execution design
 * §3.3, §3.3.1): analysis anchors and ranges are grid frame numbers; scene_cuts and tracked_mask results carry the grid fps
 * and grid frame count, cuts are `{ frameIndex, detectionScore }` grid frames, and `timeBase` and `sourceFrameMapping` are gone.
 */

import { describe, expect, it } from "vitest";
import { miniToolAnalysisInputSchema } from "../analysis-input.js";
import { miniToolAnalysisResultSchema } from "../analysis-record.js";

const SOURCE_URL = "https://media.example.test/source.mp4";
const profile = { id: "detector-v1", version: "1.2.3", weightsHash: null, params: { threshold: 0.4 } };
const binding = {
  assetId: "10000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: SOURCE_URL, kind: "video",
  mediaInfo: { width: 960, height: 540, duration: 5, mimeType: "video/mp4" },
};
const fps25 = { numerator: 25, denominator: 1 };
const common = { schemaVersion: 1, sourceURL: SOURCE_URL, profile };
const region = { box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, points: [] };

/**
 * The identity part of a result for an analysis input.
 * @param analysisInput - The frozen input.
 * @returns The identity fields.
 */
function identity(analysisInput: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1, draftId: "20000000-0000-4000-8000-000000000001", revision: "40000000-0000-4000-8000-000000000001",
    analysisRunId: "00000000-0000-4000-8000-000000000001", acceptedAt: "2026-10-24T09:03:03.000001Z", binding, analysisInput, inputFingerprint: "b".repeat(64),
  };
}

const rleRef = {
  role: "rle", assetId: "30000000-0000-4000-8000-000000000001", canonicalURL: "https://media.example.test/mask.json", contentHash: "d".repeat(64),
  kind: "document", mimeType: "text/plain", size: 2048, frameMetadata: null,
};

describe("SC12: analysis anchors and ranges are grid frame numbers", () => {
  it("SC12: a people anchor is its grid frame number", () => {
    expect(miniToolAnalysisInputSchema.safeParse({ ...common, kind: "people", anchor: { frameIndex: 3 } }).success).toBe(true);
  });

  it("SC12: a range is grid frames, so a fractional range is refused", () => {
    expect(miniToolAnalysisInputSchema.safeParse({ ...common, kind: "scene_cuts", range: { start: 0, end: 125 } }).success).toBe(true);
    expect(miniToolAnalysisInputSchema.safeParse({ ...common, kind: "scene_cuts", range: { start: 0.5, end: 2.25 } }).success).toBe(false);
    expect(miniToolAnalysisInputSchema.safeParse({ ...common, kind: "tracked_mask", range: { start: 0, end: 4.5 }, anchor: { frameIndex: 3 }, region, trackingPrompt: "p" }).success).toBe(false);
  });

  it("SC12: scene_cuts results carry the grid fps and frame count, cuts are grid frames without seconds", () => {
    const input = { ...common, kind: "scene_cuts", range: { start: 0, end: 125 } };
    const result = { ...identity(input), kind: "scene_cuts", fps: fps25, frameCount: 125, cuts: [{ frameIndex: 50, detectionScore: 0.9 }] };
    expect(miniToolAnalysisResultSchema.safeParse(result).success).toBe(true);
    expect(miniToolAnalysisResultSchema.safeParse({ ...result, cuts: [{ frameIndex: 50, pts: 2, detectionScore: 0.9 }] }).success).toBe(false);
    const { fps: _fps, ...withoutFps } = result;
    expect(miniToolAnalysisResultSchema.safeParse({ ...withoutFps, timeBase: { numerator: 1, denominator: 1000 } }).success).toBe(false);
  });

  it("SC12: tracked_mask results carry the grid fps and frame count with no timeBase or sourceFrameMapping", () => {
    const anchor = { frameIndex: 3 };
    const input = { ...common, kind: "tracked_mask", range: { start: 0, end: 125 }, anchor, region, trackingPrompt: "the person" };
    const result = {
      ...identity(input), kind: "tracked_mask", width: 960, height: 540, frameCount: 125, fps: fps25,
      anchor, regionFingerprint: "c".repeat(64), artifactRefs: [rleRef],
    };
    expect(miniToolAnalysisResultSchema.safeParse(result).success).toBe(true);
    const mapping = Array.from({ length: 125 }, (_, frameIndex) => ({ frameIndex, sourcePts: frameIndex / 25 }));
    expect(miniToolAnalysisResultSchema.safeParse({ ...result, sourceFrameMapping: mapping }).success).toBe(false);
  });
});
