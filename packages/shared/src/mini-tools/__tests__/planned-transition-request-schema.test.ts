// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 item 2 (frames-split §7.11 fresh row, §7.13; canvas design invariant 11.2; D11-3, D12-2): the
 * planned `video.transitions` request keeps the draft's `params.clips` and holds exactly two clips, one on the node's
 * current video (the draft input whose `sourceNodeId` is the host node) and one on the picked input, in either order; it
 * plans one output; `presentation_ref` maps each clip's input id to the tool input it was planned against, one entry per
 * input and no other. The output recipe below is `{ kind: "transitions" }` by analogy with remove-bg's `{ kind: "remove-bg" }`
 * (no selection facts); §97 lists it under 需要确认.
 */
import { describe, expect, it } from "vitest";
import { miniToolPlannedRequestSchema, miniToolSubmissionSchema } from "@shared/mini-tools/planned-request-schema.js";

const HOST = "30000000-0000-4000-8000-000000000001";
const PICKED_NODE = "30000000-0000-4000-8000-000000000002";
const OUTPUT_NODE = "40000000-0000-4000-8000-000000000001";
const CURRENT = "80000000-0000-4000-8000-000000000001";
const PICKED = "80000000-0000-4000-8000-000000000002";
const OTHER = "80000000-0000-4000-8000-000000000003";
const TRANSITION_RECIPE = { kind: "transitions" };
const ref = (letter: string): { toolInputId: string; planSha256: string } => ({ toolInputId: letter.repeat(64), planSha256: "d".repeat(64) });
type Body = Record<string, unknown> & {
  draft: { inputs: Record<string, unknown>[]; params: { clips: Record<string, unknown>[] } }; presentation_ref: Record<string, unknown>; outputs: Record<string, unknown>[];
};
const media = { width: 960, height: 540, duration: 5, mimeType: "video/mp4" };

/**
 * One timeline clip on an input.
 * @param clip - The clip id's last digit.
 * @param inputId - The input it plays.
 * @param transition - Its outgoing transition.
 * @returns The clip.
 */
function clip(clip: number, inputId: string, transition: { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number } = { kind: "cut", duration: 0 }): Record<string, unknown> {
  return { clipId: `90000000-0000-4000-8000-00000000000${clip}`, inputId, in: 0, out: 4, transition };
}

/**
 * A complete transitions request: the current video first, a fade, then the picked input.
 * @returns A fresh body.
 */
function request(): Record<string, unknown> {
  return {
    tool: "video.transitions", project_id: "10000000-0000-4000-8000-000000000001", space_id: "20000000-0000-4000-8000-000000000001", run_id: "50000000-0000-4000-8000-000000000001",
    draft: { version: 1, draftId: "60000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000001",
      source: { nodeId: HOST, canonicalURL: "https://assets.example.test/current.mp4", mediaInfo: media },
      inputs: [
        { inputId: CURRENT, url: "https://assets.example.test/current.mp4", mediaInfo: media, sourceNodeId: HOST },
        { inputId: PICKED, url: "https://assets.example.test/picked.mp4", mediaInfo: media, sourceNodeId: PICKED_NODE },
      ],
      params: { clips: [clip(1, CURRENT, { kind: "fade", duration: 0.5 }), clip(2, PICKED)] } },
    analysis_refs: [], presentation_ref: { [CURRENT]: ref("a"), [PICKED]: ref("b") },
    outputs: [{ outputIndex: 0, nodeId: OUTPUT_NODE, recipe: { ...TRANSITION_RECIPE } }],
  };
}

/**
 * A changed copy of the control request.
 * @param change - The edit applied to the copy.
 * @returns The copy.
 */
function changed(change: (body: Body) => void): Record<string, unknown> {
  const body = structuredClone(request()) as Body;
  change(body);
  return body;
}

describe("the planned transitions request (§97 D11-3, D12-2; frames-split §7.11, §7.13)", () => {
  it("TQ01 accepts the current video and one picked input with a ref per clip input, and keeps every field", () => {
    expect(miniToolPlannedRequestSchema.parse(request())).toEqual(request());
    expect(miniToolSubmissionSchema.parse(request())).toEqual(request());
  });

  it("TQ01 accepts the swapped order and a Cut between the two clips", () => {
    const swapped = changed((body) => { body.draft.params.clips = [clip(2, PICKED, { kind: "cut", duration: 0 }), clip(1, CURRENT)]; });
    expect(miniToolPlannedRequestSchema.parse(swapped)).toEqual(swapped);
  });

  it.each([
    ["one clip", (body: Body) => { body.draft.params.clips = [clip(1, CURRENT)]; body.presentation_ref = { [CURRENT]: ref("a") }; }],
    ["three clips", (body: Body) => { body.draft.params.clips.push(clip(3, PICKED)); }],
    ["both clips on the current video", (body: Body) => {
      body.draft.params.clips = [clip(1, CURRENT, { kind: "fade", duration: 0.5 }), clip(2, CURRENT)]; body.presentation_ref = { [CURRENT]: ref("a") };
    }],
    ["no clip on the current video", (body: Body) => {
      body.draft.inputs.push({ inputId: OTHER, url: "https://assets.example.test/other.mp4", mediaInfo: media });
      body.draft.params.clips = [clip(1, OTHER, { kind: "fade", duration: 0.5 }), clip(2, PICKED)]; body.presentation_ref = { [OTHER]: ref("c"), [PICKED]: ref("b") };
    }],
    ["a clip on an input the draft does not hold", (body: Body) => {
      body.draft.params.clips = [clip(1, CURRENT, { kind: "fade", duration: 0.5 }), clip(2, OTHER)]; body.presentation_ref = { [CURRENT]: ref("a"), [OTHER]: ref("c") };
    }],
    ["a ref missing for a clip input", (body: Body) => { body.presentation_ref = { [CURRENT]: ref("a") }; }],
    ["a ref for an input no clip plays", (body: Body) => { body.presentation_ref[OTHER] = ref("c"); }],
    ["the single-input source ref", (body: Body) => { body.presentation_ref = { source: ref("a") }; }],
    ["a ref without its plan digest", (body: Body) => { body.presentation_ref[PICKED] = { toolInputId: "b".repeat(64) }; }],
    ["two outputs", (body: Body) => { body.outputs.push({ outputIndex: 1, nodeId: "40000000-0000-4000-8000-000000000002", recipe: { ...TRANSITION_RECIPE } }); }],
    ["no output", (body: Body) => { body.outputs = []; }],
    ["the output on the host node", (body: Body) => { body.outputs[0]!.nodeId = HOST; }],
    ["a frame recipe", (body: Body) => { body.outputs[0]!.recipe = { kind: "frame", frameIndex: 0, pts: 0 }; }],
  ])("TQ02 refuses %s after a valid control", (_name, change) => {
    expect(miniToolPlannedRequestSchema.safeParse(request()).success).toBe(true);
    expect(miniToolPlannedRequestSchema.safeParse(changed(change)).success).toBe(false);
  });
});
