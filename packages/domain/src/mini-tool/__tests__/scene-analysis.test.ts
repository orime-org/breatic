// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Scene analysis assembly on presentation ordinals (inner#1306 test plan §93 D5-7, D5-8; frames-split design §7.17
 * scene_cuts row 「切点按呈现序号记录；结果组装按compact核对」, 「去掉inspect_video步骤」).
 *
 * The container writes `{ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ ordinal, detectionScore }] }`; the worker gives
 * each ordinal its presented `{ frameIndex, pts }` through `sceneCutsResultOf` on the frozen ledger and passes them with the
 * presentation clock. The record keeps `{ frameIndex, pts, detectionScore }`; `frameCount` is the ledger's frame count and
 * `timeBase` is 1/timescale. There is no inspect_video input and no frame-table check.
 *
 * This round's choice of the assembler's inputs (may be vetoed): `(accepted, observations, placed, clock)`, where
 * `placed` are the worker's mapped cuts in the observations' order and `clock` is `{ frameCount, timescale }`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { miniToolAnalysisRecordSchema, type MiniToolAnalysisRecord, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { assembleMiniToolSceneAnalysis as assembleImpl } from "../scene-analysis.js";

type Placed = { frameIndex: number; pts: number }[];
type Assemble = (accepted: MiniToolAnalysisRecord, observations: unknown, placed: Placed, clock: { frameCount: number; timescale: number }) => Extract<MiniToolAnalysisResult, { kind: "scene_cuts" }>;
const assemble = assembleImpl as unknown as Assemble;

// The cfr96 presentation: 96 frames of 1/25 s; the scanned range starts on keyframe 48 and ends at the display end.
const CLOCK = { frameCount: 96, timescale: 25 };
const observations = { schemaVersion: 1, kind: "scene_cuts", cuts: [{ ordinal: 60, detectionScore: 85 }] };
const placed: Placed = [{ frameIndex: 60, pts: 2.4 }];
const accepted = miniToolAnalysisRecordSchema.parse({
  schemaVersion: 1, draftId: "10000000-0000-4000-8000-000000000001", revision: "20000000-0000-4000-8000-000000000001",
  analysisRunId: "30000000-0000-4000-8000-000000000001", acceptedAt: "2026-10-25T00:00:00.123456Z",
  kind: "scene_cuts", inputFingerprint: "a".repeat(64),
  binding: { assetId: "40000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64),
    canonicalURL: "https://assets.test.invalid/original.mp4", kind: "video", mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "scene_cuts", sourceURL: "https://assets.test.invalid/original.mp4",
    profile: { id: "scene-detector", version: "1", weightsHash: null, params: {} }, range: { start: 1.92, end: 3.84 } },
  status: "running", result: null, error: null, usage: [], artifactUnavailable: false,
});
const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = accepted;
// §93 D5-8: timeBase is 1/timescale and frameCount the ledger's frame count (was the inspected source clock and table).
const expected = { ...identity, kind: "scene_cuts", timeBase: { numerator: 1, denominator: 25 }, frameCount: 96,
  cuts: [{ frameIndex: 60, pts: 2.4, detectionScore: 85 }] };

describe("scene analysis on presentation ordinals (§93 D5-7, D5-8)", () => {
  it("SC01 records each cut's ordinal, presented pts and score on the presentation clock", () => {
    expect(assemble(accepted, observations, placed, CLOCK)).toEqual(expected);
  });

  it("SC02 accepts an empty detection result", () => {
    expect(assemble(accepted, { ...observations, cuts: [] }, [], CLOCK)).toEqual({ ...expected, cuts: [] });
  });

  it("SC03 preserves every finite detector score without clamping or changing its scale", () => {
    fc.assert(fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (detectionScore) => {
      expect(assemble(accepted, { ...observations, cuts: [{ ordinal: 60, detectionScore }] }, placed, CLOCK))
        .toEqual({ ...expected, cuts: [{ frameIndex: 60, pts: 2.4, detectionScore }] });
    }));
  });

  it("SC04 keeps the detector's order and the range's first frame (keyframe 48) as a cut", () => {
    const cuts = [{ ordinal: 72, detectionScore: 3 }, { ordinal: 48, detectionScore: 9 }];
    expect(assemble(accepted, { ...observations, cuts }, [{ frameIndex: 72, pts: 2.88 }, { frameIndex: 48, pts: 1.92 }], CLOCK))
      .toEqual({ ...expected, cuts: [{ frameIndex: 72, pts: 2.88, detectionScore: 3 }, { frameIndex: 48, pts: 1.92, detectionScore: 9 }] });
  });

  it.each([
    { name: "version", patch: { schemaVersion: 2 } },
    { name: "kind", patch: { kind: "people" } },
    // §93 D5-8 (design §7.17 「容器不读帧表」): the pre-D5 source-clock fields are no longer part of the observation.
    { name: "a source clock beside the cuts", patch: { timeBase: "1/100" } },
    { name: "a frame count beside the cuts", patch: { frameCount: 96 } },
    { name: "a source frame mapping beside the cuts", patch: { sourceFrameMapping: [{ frameIndex: 60, pts: 2.4 }] } },
    { name: "a cut named by frameIndex instead of ordinal", patch: { cuts: [{ frameIndex: 60, detectionScore: 85 }] } },
    { name: "a fractional ordinal", patch: { cuts: [{ ordinal: 60.5, detectionScore: 85 }] } },
    { name: "a negative ordinal", patch: { cuts: [{ ordinal: -1, detectionScore: 85 }] } },
    { name: "a string score", patch: { cuts: [{ ordinal: 60, detectionScore: "85" }] } },
    { name: "a nonfinite score", patch: { cuts: [{ ordinal: 60, detectionScore: Infinity }] } },
  ])("SC05 rejects observations with $name", ({ patch }) => {
    expect(() => assemble(accepted, { ...observations, ...patch }, placed, CLOCK)).toThrow();
  });

  it.each([
    { name: "a duplicate cut", cuts: [{ ordinal: 60, detectionScore: 85 }, { ordinal: 60, detectionScore: 85 }], at: [{ frameIndex: 60, pts: 2.4 }, { frameIndex: 60, pts: 2.4 }] },
    { name: "a placement for another ordinal", cuts: observations.cuts, at: [{ frameIndex: 61, pts: 2.44 }] },
    { name: "a missing placement", cuts: observations.cuts, at: [] },
    { name: "an extra placement", cuts: observations.cuts, at: [...placed, { frameIndex: 72, pts: 2.88 }] },
    { name: "a cut before the accepted range", cuts: [{ ordinal: 40, detectionScore: 85 }], at: [{ frameIndex: 40, pts: 1.6 }] },
    { name: "a cut at the range end", cuts: [{ ordinal: 96, detectionScore: 85 }], at: [{ frameIndex: 96, pts: 3.84 }] },
  ])("SC06 rejects $name", ({ cuts, at }) => {
    expect(() => assemble(accepted, { ...observations, cuts }, at, CLOCK)).toThrow();
  });

  it.each([
    { name: "zero frames", clock: { frameCount: 0, timescale: 25 } },
    { name: "a fractional frame count", clock: { frameCount: 96.5, timescale: 25 } },
    { name: "a zero timescale", clock: { frameCount: 96, timescale: 0 } },
    { name: "a cut past the last frame", clock: { frameCount: 60, timescale: 25 } },
  ])("SC07 rejects a presentation clock with $name", ({ clock }) => {
    expect(() => assemble(accepted, observations, placed, clock)).toThrow();
  });

  it("SC08 requires the original accepted scene analysis kind", () => {
    const people = miniToolAnalysisRecordSchema.parse({ ...accepted, kind: "people", analysisInput: { schemaVersion: 1, kind: "people",
      sourceURL: accepted.analysisInput.sourceURL, profile: accepted.analysisInput.profile, anchor: { frameIndex: 48, pts: 1.92 } } });
    expect(() => assemble(people, observations, placed, CLOCK)).toThrow();
  });
});
