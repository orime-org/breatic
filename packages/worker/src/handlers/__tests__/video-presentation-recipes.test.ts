// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recipes on the frozen version's frame grid (inner#1306 test plan §67.3 W01; frames-split design §5.5, §7.16, §7.17).
 *
 * Every recipe names grid frames of the version's tool source: the original with its source keyframe statistics, or the
 * edit file with the original bound beside it for audio (§4.4); the grid is the version's display grid. The plan colour a
 * frozen version does not carry yet is stood in by `PLAN_COLOR` (see `frozen-plan-facts.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { miniToolPlanRecipeSchema } from "@breatic/shared";
import { PLAN_COLOR, frozenVersion } from "../mini-tool/__tests__/frozen-presentation.js";
import {
  AUDIO_INPUT_ID, chunkInputId, frameRecipeOf, peopleRecipeOf, sceneCutsRecipeOf, segmentRecipesOf, SOURCE_INPUT_ID, toolInputOf,
} from "../video-presentation-recipes.js";

vi.mock("@worker/handlers/frozen-plan-facts.js", () => ({ planColorOf: () => PLAN_COLOR }));

const PROFILE = { id: "detector", version: "1", weightsHash: null, params: {} };
const GRID = { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 };
const KEYFRAMES = { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false };
const ENCODE = { crf: 18, preset: "medium" as const };

describe("the tool source a recipe reads (§7.16)", () => {
  it("W01 a version without an edit file is read from the original with its source keyframe statistics", () => {
    expect(toolInputOf(frozenVersion(), "video/source.mp4")).toEqual({
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: "video/source.mp4" }], inputId: SOURCE_INPUT_ID, grid: GRID, source: { kind: "original", keyframes: KEYFRAMES },
    });
  });

  it("W01 a version with an edit file is read from it, the original bound beside it for audio", () => {
    expect(toolInputOf(frozenVersion({ editKey: "video/edit.mp4" }), "video/source.mp4")).toEqual({
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: "video/edit.mp4" }, { inputId: AUDIO_INPUT_ID, storageKey: "video/source.mp4" }],
      inputId: SOURCE_INPUT_ID, grid: GRID, source: { kind: "edit" }, audioInputId: AUDIO_INPUT_ID,
    });
  });

  it("W01 the grid is the version's display grid: rate, grid start, slots and real slots", () => {
    const version = frozenVersion({ fps: { numerator: 30000, denominator: 1001 }, gridStart: { numerator: 1467, denominator: 1000 }, frameCount: 40 });
    expect(toolInputOf(version, "k").grid).toEqual({ fps: { numerator: 30000, denominator: 1001 }, gridStart: { numerator: 1467, denominator: 1000 }, frameCount: 40, realFrameCount: 40 });
  });
});

describe("frames, focus crops and segments (§7.17 frame and segment rows; §5.5)", () => {
  it("W01 a frame is its grid frame with the plan's PNG target; it reads the tool source only", () => {
    const version = frozenVersion({ editKey: "video/edit.mp4" });
    const { recipe, inputs } = frameRecipeOf(version, toolInputOf(version, "video/source.mp4"), 12);
    expect(recipe).toEqual({ kind: "frame", inputId: SOURCE_INPUT_ID, grid: GRID, source: { kind: "edit" }, frameIndex: 12,
      target: { width: 320, height: 180, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } });
    expect(inputs).toEqual([{ inputId: SOURCE_INPUT_ID, storageKey: "video/edit.mp4" }]);
    expect(() => miniToolPlanRecipeSchema.parse(recipe)).not.toThrow();
  });

  it("F01 a video focus crop is the same frame recipe with its rectangle in P.display", () => {
    const version = frozenVersion();
    const { recipe } = frameRecipeOf(version, toolInputOf(version, "k"), 3, { x: 10, y: 20, width: 100, height: 50 });
    expect(recipe).toMatchObject({ kind: "frame", frameIndex: 3, crop: { sourceWidth: 320, sourceHeight: 180, rect: { x: 10, y: 20, width: 100, height: 50 } } });
    expect(() => miniToolPlanRecipeSchema.parse(recipe)).not.toThrow();
  });

  it("W01 a transparent version's frame keeps straight alpha", () => {
    const version = frozenVersion({ transparent: true });
    expect(frameRecipeOf(version, toolInputOf(version, "k"), 0).recipe).toMatchObject({ target: { alpha: "straight" } });
  });

  it("W01 an unchunked segment is one segment over its grid frames with the original's audio, H.264 on even sides (§4.3)", () => {
    const version = frozenVersion({ width: 321, height: 1, editKey: "video/edit.mp4" });
    const { recipes, inputs } = segmentRecipesOf(version, "video/source.mp4", { start: 4, end: 40 }, ENCODE, [{ start: 4, end: 40 }]);
    expect(recipes).toEqual([{ kind: "segment", inputId: SOURCE_INPUT_ID, grid: { ...GRID }, source: { kind: "edit" }, frames: { start: 4, end: 40 },
      target: { width: 320, height: 2, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" },
      audio: true, audioInputId: AUDIO_INPUT_ID }]);
    expect(inputs.map((input) => input.inputId)).toEqual([SOURCE_INPUT_ID, AUDIO_INPUT_ID]);
    expect(() => miniToolPlanRecipeSchema.parse(recipes[0])).not.toThrow();
  });

  it("W01 a transparent segment is VP9 at the display size, odd sides kept", () => {
    const version = frozenVersion({ width: 321, height: 181, transparent: true });
    const { recipes } = segmentRecipesOf(version, "k", { start: 0, end: 10 }, ENCODE, [{ start: 0, end: 10 }]);
    expect(recipes[0]).toMatchObject({ target: { width: 321, height: 181, alpha: "straight", format: "webm-vp9" } });
  });

  it("W01 a chunked segment is one chunk_encode per frozen window and a stitch over them in order with the original's audio (§5.4)", () => {
    const version = frozenVersion();
    const { recipes } = segmentRecipesOf(version, "k", { start: 0, end: 96 }, ENCODE, [{ start: 0, end: 48 }, { start: 48, end: 96 }]);
    expect(recipes.map((recipe) => recipe.kind)).toEqual(["chunk_encode", "chunk_encode", "stitch"]);
    expect(recipes[1]).toMatchObject({ frames: { start: 48, end: 96 }, source: { kind: "original", keyframes: KEYFRAMES } });
    expect(recipes[2]).toMatchObject({ kind: "stitch", inputId: SOURCE_INPUT_ID, grid: GRID, audio: true,
      chunks: [{ inputId: chunkInputId(0), frames: { start: 0, end: 48 } }, { inputId: chunkInputId(1), frames: { start: 48, end: 96 } }] });
    for (const recipe of recipes) expect(() => miniToolPlanRecipeSchema.parse(recipe)).not.toThrow();
  });
});

describe("analysis recipes (§7.17 人物检测锚帧 and scene_cuts rows)", () => {
  it("W01 the people detector reads the anchor's grid frame", () => {
    const version = frozenVersion();
    const recipe = peopleRecipeOf(version, toolInputOf(version, "k", "70000000-0000-4000-8000-000000000001"), 7, PROFILE);
    expect(recipe).toMatchObject({ kind: "people", inputId: "70000000-0000-4000-8000-000000000001", frameIndex: 7, grid: GRID, profile: PROFILE });
    expect(() => miniToolPlanRecipeSchema.parse(recipe)).not.toThrow();
  });

  it("W01 the scene detector reads the range's grid frames, with no inspect step", () => {
    const version = frozenVersion();
    const recipe = sceneCutsRecipeOf(version, toolInputOf(version, "k"), { start: 10, end: 60 }, PROFILE);
    expect(recipe).toEqual({ kind: "scene_cuts", inputId: SOURCE_INPUT_ID, grid: GRID, source: { kind: "original", keyframes: KEYFRAMES }, frames: { start: 10, end: 60 },
      profile: PROFILE, target: { width: 320, height: 180, colorMatrix: "bt709", toneMap: "none" } });
    expect(() => miniToolPlanRecipeSchema.parse(recipe)).not.toThrow();
  });
});
