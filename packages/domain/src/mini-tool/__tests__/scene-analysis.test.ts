// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { miniToolAnalysisRecordSchema } from "@breatic/shared/mini-tools";
import { assembleMiniToolSceneAnalysis } from "../scene-analysis.js";

// The independent S1 oracle fixes a nonlinear 60-frame source, selected indices
// 10..49, and source cut 30 at 9.3 seconds with unnormalised score 85.
const frames = Array.from({ length: 60 }, (_, frameIndex) => ({ frameIndex, pts: (frameIndex * frameIndex + frameIndex) / 100 }));
const inspection = {
  schemaVersion: 1, kind: "inspect_video",
  source: { width: 400, height: 200, timeBase: "1/100", rotation: 0, hasAudio: false, frameTable: { frames, videoEnd: 36.4 } },
  probe: {},
};
const observations = {
  schemaVersion: 1, kind: "scene_cuts", timeBase: "1/100", frameCount: 60,
  sourceFrameMapping: frames.slice(10, 50), cuts: [{ frameIndex: 30, pts: 9.3, detectionScore: 85 }],
};
const accepted = miniToolAnalysisRecordSchema.parse({
  schemaVersion: 1, draftId: "10000000-0000-4000-8000-000000000001", revision: "20000000-0000-4000-8000-000000000001",
  analysisRunId: "30000000-0000-4000-8000-000000000001", acceptedAt: "2026-10-25T00:00:00.123456Z",
  kind: "scene_cuts", inputFingerprint: "a".repeat(64),
  binding: { assetId: "40000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64),
    canonicalURL: "https://assets.test.invalid/original.mp4", kind: "video", mediaInfo: { width: 400, height: 200, duration: 36.4, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "scene_cuts", sourceURL: "https://assets.test.invalid/original.mp4",
    profile: { id: "scene-detector", version: "1", weightsHash: null, params: {} }, range: { start: 1.1, end: 25.5 } },
  status: "running", result: null, error: null, usage: [], artifactUnavailable: false,
});
const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = accepted;
const expected = { ...identity, kind: "scene_cuts", timeBase: { numerator: 1, denominator: 100 }, frameCount: 60,
  cuts: [{ frameIndex: 30, pts: 9.3, detectionScore: 85 }] };

describe("scene analysis source associations", () => {
  it("retains the full source count and nonlinear source cut without a second offset", () => {
    expect(assembleMiniToolSceneAnalysis(accepted, inspection, observations)).toEqual(expected);
  });

  it("accepts an empty detection result while preserving its original source facts", () => {
    expect(assembleMiniToolSceneAnalysis(accepted, inspection, { ...observations, cuts: [] })).toEqual({ ...expected, cuts: [] });
  });

  it("preserves every finite detector score without clamping or changing its scale", () => {
    fc.assert(fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (detectionScore) => {
      const cuts = [{ frameIndex: 30, pts: 9.3, detectionScore }];
      expect(assembleMiniToolSceneAnalysis(accepted, inspection, { ...observations, cuts })).toEqual({ ...expected, cuts });
    }));
  });

  it("retains raw negative leading PTS and rotation without renumbering the selected frames", () => {
    const source = { ...inspection.source, rotation: 90, frameTable: { ...inspection.source.frameTable, frames: [{ frameIndex: 0, pts: -0.04 }, ...frames.slice(1)] } };
    expect(assembleMiniToolSceneAnalysis(accepted, { ...inspection, source }, observations)).toEqual(expected);
  });

  it("accepts equal PTS on distinct source frames and preserves their original indices", () => {
    const tied = frames.map((frame) => frame.frameIndex === 31 ? { ...frame, pts: 9.3 } : frame);
    const source = { ...inspection.source, frameTable: { ...inspection.source.frameTable, frames: tied } };
    const cuts = [...observations.cuts, { frameIndex: 31, pts: 9.3, detectionScore: 0.5 }];
    expect(assembleMiniToolSceneAnalysis(accepted, { ...inspection, source }, { ...observations, sourceFrameMapping: tied.slice(10, 50), cuts })).toEqual({ ...expected, cuts });
  });

  it.each([
    { name: "version", patch: { schemaVersion: 2 } },
    { name: "kind", patch: { kind: "people" } },
    { name: "clock type", patch: { timeBase: 0.01 } },
    { name: "zero clock denominator", patch: { timeBase: "1/0" } },
    { name: "zero clock numerator", patch: { timeBase: "0/100" } },
    { name: "fractional clock component", patch: { timeBase: "1.5/100" } },
    { name: "unsafe clock component", patch: { timeBase: "1/9007199254740992" } },
    { name: "different source clock", patch: { timeBase: "1/1000" } },
    { name: "range count substituted for full count", patch: { frameCount: 40 } },
    { name: "fractional count", patch: { frameCount: 60.5 } },
    { name: "missing mapping", patch: { sourceFrameMapping: undefined } },
    { name: "missing mapped frame", patch: { sourceFrameMapping: frames.slice(11, 50) } },
    { name: "outside-range mapping", patch: { sourceFrameMapping: frames.slice(9, 50) } },
    { name: "duplicate mapped frame", patch: { sourceFrameMapping: [...frames.slice(10, 49), frames[48]] } },
    { name: "reordered mapping", patch: { sourceFrameMapping: frames.slice(10, 50).reverse() } },
    { name: "changed mapped PTS", patch: { sourceFrameMapping: frames.slice(10, 50).map((frame) => frame.frameIndex === 30 ? { ...frame, pts: 9.31 } : frame) } },
    { name: "duplicate cut", patch: { cuts: [...observations.cuts, ...observations.cuts] } },
    { name: "out-of-source cut", patch: { cuts: [{ frameIndex: 60, pts: 36.6, detectionScore: 85 }] } },
    { name: "outside-range cut", patch: { cuts: [{ frameIndex: 9, pts: 0.9, detectionScore: 85 }] } },
    { name: "range-end cut", patch: { cuts: [{ frameIndex: 50, pts: 25.5, detectionScore: 85 }] } },
    { name: "changed cut PTS", patch: { cuts: [{ frameIndex: 30, pts: 9.31, detectionScore: 85 }] } },
    { name: "string score", patch: { cuts: [{ frameIndex: 30, pts: 9.3, detectionScore: "85" }] } },
    { name: "nonfinite score", patch: { cuts: [{ frameIndex: 30, pts: 9.3, detectionScore: Infinity }] } },
  ])("rejects $name observations", ({ patch }) => {
    expect(() => assembleMiniToolSceneAnalysis(accepted, inspection, { ...observations, ...patch })).toThrow();
  });

  it.each([
    { name: "version", value: { ...inspection, schemaVersion: 2 } },
    { name: "kind", value: { ...inspection, kind: "people" } },
    { name: "invalid original clock", value: { ...inspection, source: { ...inspection.source, timeBase: "1/0" } } },
    { name: "noncontiguous indices", value: { ...inspection, source: { ...inspection.source, frameTable: { frames: frames.slice(1), videoEnd: 36.4 } } } },
    { name: "changed ledger PTS", value: { ...inspection, source: { ...inspection.source, frameTable: { frames: frames.map((frame) => frame.frameIndex === 30 ? { ...frame, pts: 9.31 } : frame), videoEnd: 36.4 } } } },
    { name: "nonfinite PTS", value: { ...inspection, source: { ...inspection.source, frameTable: { frames: [{ frameIndex: 0, pts: Infinity }, ...frames.slice(1)], videoEnd: 36.4 } } } },
  ])("rejects $name inspected facts", ({ value }) => {
    expect(() => assembleMiniToolSceneAnalysis(accepted, value, observations)).toThrow();
  });

  it.each([
    { name: "zero width", patch: { width: 0 } },
    { name: "fractional height", patch: { height: 20.5 } },
    { name: "nonfinite rotation", patch: { rotation: Infinity } },
    { name: "missing audio fact", patch: { hasAudio: undefined } },
    { name: "empty ledger", patch: { frameTable: { frames: [], videoEnd: 36.4 } } },
    { name: "descending source PTS", patch: { frameTable: { frames: frames.map((frame) => frame.frameIndex === 30 ? { ...frame, pts: 8 } : frame), videoEnd: 36.4 } } },
    { name: "unresolved endpoint", patch: { frameTable: { frames, videoEnd: undefined } } },
    { name: "endpoint at final source frame", patch: { frameTable: { frames, videoEnd: 35.4 } } },
    { name: "extra source field", patch: { guessedFps: 30 } },
  ])("rejects $name source facts", ({ patch }) => {
    expect(() => assembleMiniToolSceneAnalysis(accepted, { ...inspection, source: { ...inspection.source, ...patch } }, observations)).toThrow();
  });

  it("rejects an empty source range even when the detector mapping is empty", () => {
    const outside = miniToolAnalysisRecordSchema.parse({ ...accepted, analysisInput: { ...accepted.analysisInput, range: { start: 40, end: 41 } } });
    expect(() => assembleMiniToolSceneAnalysis(outside, inspection, { ...observations, sourceFrameMapping: [], cuts: [] })).toThrow();
  });

  it("requires the original accepted scene analysis kind", () => {
    const people = miniToolAnalysisRecordSchema.parse({ ...accepted, kind: "people", analysisInput: { schemaVersion: 1, kind: "people",
      sourceURL: accepted.analysisInput.sourceURL, profile: accepted.analysisInput.profile, anchor: { frameIndex: 1, pts: 0.02 } } });
    expect(() => assembleMiniToolSceneAnalysis(people, inspection, observations)).toThrow();
  });
});
