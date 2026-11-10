// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Several takes of one template in one proposal (inner#1825 design 8.6):
 * each take is an anchor carrying `{ id }`, a shared input is one node wired
 * or filled into every take, and every take keeps what its template places,
 * the guide among it.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { setLocale, TEMPLATE_GUIDE_KEY } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { getGenerationTemplate } from "../get-generation-template.js";
import { answerFor, type MaterialTable } from "../propose-canvas-action.js";

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/** What the model sends, as the tool's input. */
type Sent = Parameters<typeof answerFor>[0];

const CLIP = "https://resource.example/video/2026-11-10/1_clip.mp4";
const MATERIALS: MaterialTable = new Map([
  [CLIP, { kind: "video", media: { coverUrl: null, width: 1280, height: 720, duration: 30, mimeType: "video/mp4", size: 1000 } }],
]);

/**
 * One take of a template: its anchor with the words written.
 * @param id - The template.
 * @param words - Its prompt.
 * @param rest - Anything else on the node.
 * @returns The node.
 */
function take(id: string, words: string, rest: Partial<Sent["nodes"][number]> = {}): Sent["nodes"][number] {
  return { role: "generate", type: "audio", name: words.slice(0, 20), template: { id }, prompt: [{ text: words }], ...rest };
}

describe("two takes of score-for-my-video sharing the user's video", () => {
  /**
   * The proposal with the video wired or filled into both takes.
   * @param shared - How the video reaches each take.
   * @returns What the model sends.
   */
  const twoTakes = (shared: "fills" | "edges"): Sent => {
    // A node wired in empty takes a note on each take it goes into.
    const how = (words: string): Partial<Sent["nodes"][number]> =>
      shared === "fills" ? { fills: { video: [0] } } : { prompt: [{ slot: { kind: "note", label: "Put your clip in, then pick it into the Video slot" } }, { text: words }] };
    return {
    nodes: [
      // Material goes in through fills; an empty node for the user to fill is wired in.
      { role: "source", type: "video", name: "My clip", ...(shared === "fills" ? { material: CLIP } : {}), template: { id: "score-for-my-video", input: "video" } },
      take("score-for-my-video", "Warm acoustic folk with light percussion.", how("Warm acoustic folk with light percussion.")),
      take("score-for-my-video", "Bright synth pop with a steady beat.", how("Bright synth pop with a steady beat.")),
    ],
    edges: shared === "edges" ? [{ fromIndex: 0, toIndex: 1, into: "video" }, { fromIndex: 0, toIndex: 2, into: "video" }] : [],
    rationale: "Two styles for the clip.",
    groupName: "Music for my clip",
    };
  };

  it("is placed with the video filled into both takes' slot", () => {
    expect(answerFor(twoTakes("fills"), MATERIALS)).toMatchObject({ placed: true });
  });

  it("is placed with an empty video node wired into both takes", () => {
    const answer = answerFor(twoTakes("edges"), MATERIALS);
    expect(answer.placed ? "" : answer.reason).toBe("");
  });
});

describe("two takes of underscore-bgm", () => {
  it("lands a guide for each take", () => {
    const answer = answerFor({
      nodes: [take("underscore-bgm", "Calm piano under a voice-over, 40 seconds."), take("underscore-bgm", "Soft guitar under a voice-over, 40 seconds.")],
      edges: [],
      rationale: "Two styles.",
      groupName: "Background music",
    });
    expect(answer).toMatchObject({ placed: true });
    if (!answer.placed) return;
    const guides = answer.nodes.filter((node) => node.templateNode?.key === TEMPLATE_GUIDE_KEY);
    expect(guides.map((node) => node.templateNode?.anchor).sort()).toEqual([0, 1]);
  });
});

describe("how to send takes, as the template's read says", () => {
  it("says each take is an anchor carrying { id } and a shared input is one node wired or filled into every take", async () => {
    const execute = (getGenerationTemplate as unknown as { execute: (input: { id: string }, options: object) => Promise<string> }).execute;
    const text = await execute({ id: "score-for-my-video" }, {});
    expect(text).toMatch(/several takes of one template/);
    expect(text).toMatch(/each take is an anchor carrying \{ id \}/);
    expect(text).toMatch(/one node wired or filled into every take/);
  });
});
