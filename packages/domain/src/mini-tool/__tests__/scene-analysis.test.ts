// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Scene analysis assembly on grid frames (frames-split design §7.16, §10.12).
 *
 * The container writes `{ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ frameIndex, detectionScore }] }` on the frozen grid;
 * the assembler checks each cut against the accepted range and the grid's frame count, and the record keeps the grid's fps
 * and frame count beside the cuts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { miniToolAnalysisRecordSchema } from "@breatic/shared/mini-tools";
import { assembleMiniToolSceneAnalysis as assemble } from "../scene-analysis.js";

// A 96-frame grid at 25 fps; the scanned range starts on grid frame 48 and ends at the grid end.
const GRID = { fps: { numerator: 25, denominator: 1 }, frameCount: 96 };
const observations = { schemaVersion: 1, kind: "scene_cuts", cuts: [{ frameIndex: 60, detectionScore: 85 }] };
const accepted = miniToolAnalysisRecordSchema.parse({
  schemaVersion: 1, draftId: "10000000-0000-4000-8000-000000000001", revision: "20000000-0000-4000-8000-000000000001",
  analysisRunId: "30000000-0000-4000-8000-000000000001", acceptedAt: "2026-10-25T00:00:00.123456Z",
  kind: "scene_cuts", inputFingerprint: "a".repeat(64),
  binding: { assetId: "40000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64),
    canonicalURL: "https://assets.test.invalid/original.mp4", kind: "video", mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "scene_cuts", sourceURL: "https://assets.test.invalid/original.mp4",
    profile: { id: "scene-detector", version: "1", weightsHash: null, params: {} }, range: { start: 48, end: 96 } },
  status: "running", result: null, error: null, usage: [], artifactUnavailable: false,
});
const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = accepted;
const expected = { ...identity, kind: "scene_cuts", fps: GRID.fps, frameCount: 96, cuts: [{ frameIndex: 60, detectionScore: 85 }] };

describe("scene analysis on grid frames (frames-split §7.16, §10.12)", () => {
  it("SC01 records each cut's grid frame and score with the grid's fps and frame count", () => {
    expect(assemble(accepted, observations, GRID)).toEqual(expected);
  });

  it("SC02 accepts an empty detection result", () => {
    expect(assemble(accepted, { ...observations, cuts: [] }, GRID)).toEqual({ ...expected, cuts: [] });
  });

  it("SC03 preserves every finite detector score without clamping or changing its scale", () => {
    fc.assert(fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (detectionScore) => {
      expect(assemble(accepted, { ...observations, cuts: [{ frameIndex: 60, detectionScore }] }, GRID))
        .toEqual({ ...expected, cuts: [{ frameIndex: 60, detectionScore }] });
    }));
  });

  it("SC04 keeps the detector's order and the range's first frame as a cut", () => {
    const cuts = [{ frameIndex: 72, detectionScore: 3 }, { frameIndex: 48, detectionScore: 9 }];
    expect(assemble(accepted, { ...observations, cuts }, GRID)).toEqual({ ...expected, cuts });
  });

  it.each([
    { name: "version", patch: { schemaVersion: 2 } },
    { name: "kind", patch: { kind: "people" } },
    { name: "a time base beside the cuts", patch: { timeBase: "1/100" } },
    { name: "a frame count beside the cuts", patch: { frameCount: 96 } },
    { name: "a cut named by ordinal", patch: { cuts: [{ ordinal: 60, detectionScore: 85 }] } },
    { name: "a cut carrying pts", patch: { cuts: [{ frameIndex: 60, pts: 2.4, detectionScore: 85 }] } },
    { name: "a fractional frame", patch: { cuts: [{ frameIndex: 60.5, detectionScore: 85 }] } },
    { name: "a negative frame", patch: { cuts: [{ frameIndex: -1, detectionScore: 85 }] } },
    { name: "a string score", patch: { cuts: [{ frameIndex: 60, detectionScore: "85" }] } },
    { name: "a nonfinite score", patch: { cuts: [{ frameIndex: 60, detectionScore: Infinity }] } },
  ])("SC05 rejects observations with $name", ({ patch }) => {
    expect(() => assemble(accepted, { ...observations, ...patch }, GRID)).toThrow();
  });

  it.each([
    { name: "a duplicate cut", cuts: [{ frameIndex: 60, detectionScore: 85 }, { frameIndex: 60, detectionScore: 85 }] },
    { name: "a cut before the accepted range", cuts: [{ frameIndex: 40, detectionScore: 85 }] },
    { name: "a cut at the range end", cuts: [{ frameIndex: 96, detectionScore: 85 }] },
  ])("SC06 rejects $name", ({ cuts }) => {
    expect(() => assemble(accepted, { ...observations, cuts }, GRID)).toThrow();
  });

  it.each([
    { name: "zero frames", grid: { ...GRID, frameCount: 0 } },
    { name: "a fractional frame count", grid: { ...GRID, frameCount: 96.5 } },
    { name: "a zero fps numerator", grid: { ...GRID, fps: { numerator: 0, denominator: 1 } } },
    { name: "a fractional fps", grid: { ...GRID, fps: { numerator: 29.97, denominator: 1 } } },
    { name: "a cut past the last frame", grid: { ...GRID, frameCount: 60 } },
  ])("SC07 rejects a grid with $name", ({ grid }) => {
    expect(() => assemble(accepted, observations, grid)).toThrow();
  });

  it("SC08 requires the original accepted scene analysis kind", () => {
    const people = miniToolAnalysisRecordSchema.parse({ ...accepted, kind: "people", analysisInput: { schemaVersion: 1, kind: "people",
      sourceURL: accepted.analysisInput.sourceURL, profile: accepted.analysisInput.profile, anchor: { frameIndex: 48 } } });
    expect(() => assemble(people, observations, GRID)).toThrow();
  });
});
