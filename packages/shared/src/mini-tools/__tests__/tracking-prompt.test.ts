// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { projectMiniToolAnalysisInput } from "../analysis-input.js";

const PROFILE = { id: "sam3-video-rle", version: "wavespeed-ai/sam3-video-rle", weightsHash: null, params: { apply_mask: false, default_prompt: "object" } };

/**
 * The tracked mask projection of a draft whose tracking prompt is the given text.
 * @param trackingPrompt - The draft's tracking prompt.
 * @returns The frozen prompt.
 */
function frozen(trackingPrompt: string): unknown {
  const input = projectMiniToolAnalysisInput({ kind: "tracked_mask", source: { canonicalURL: "https://media.example.test/source.mp4" }, profile: PROFILE,
    params: { range: { start: 0, end: 3 }, anchor: { frameIndex: 0 }, region: { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, points: [] }, trackingPrompt } });
  return input.kind === "tracked_mask" ? input.trackingPrompt : null;
}

// Execution design §10.2 prompt sentence: the erase tracking prompt is trimmed, and an empty one is the profile's default.
describe("the frozen tracking prompt (execution design §10.2)", () => {
  it("TP01 freezes the trimmed prompt, so spaces alone do not change the analysis", () => {
    expect(frozen("  the red car ")).toBe("the red car");
  });

  it("TP02 freezes the profile's default_prompt when the prompt is empty or blank", () => {
    expect(frozen("")).toBe("object");
    expect(frozen("   ")).toBe("object");
  });

  it("TP03 freezes the prompt as extractPromptText cleans it, so the web and server fingerprints agree", () => {
    expect(frozen("a  b")).toBe(frozen("a b"));
    expect(frozen("<b>red</b> car\u200B")).toBe("red car");
    expect(frozen("<p> </p>")).toBe("object");
  });
});
