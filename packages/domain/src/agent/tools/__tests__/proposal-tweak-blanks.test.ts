// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A generation is sent with every blank in its words filled (breatic#1361).
 *
 * A tweak segment left in a generate node's prompt is words the result is
 * made without. Writing them is the agent's: from what the user said, after
 * asking them, by making takes first, or by choosing as its working rules
 * say. So `template-tweak-unfilled` holds every tweak blank in a generate
 * node's prompt or shots, whether or not the node names a template and
 * whether or not the label is one the template wrote.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { answerFor, verdictFor } from "../propose-canvas-action.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/** What the model sends, as the tool's input. */
type Sent = Parameters<typeof verdictFor>[0];

/** The blank the agent left in its own words. */
const LOOK = "the look";

/** A tweak segment. */
const BLANK = { slot: { kind: "tweak" as const, label: LOOK, note: "Write the look you want" } };

/** The multi-shot node with a blank left in its first shot. */
const SHOT_BLANK: Partial<Sent["nodes"][number]> = {
  type: "video",
  name: "Clip",
  mode: "multi_shot",
  model: "kling-v3.0-4k-text-to-video",
  params: { duration: 5 },
  prompt: undefined,
  shots: [
    { prompt: [{ text: "A paper boat, in " }, BLANK], duration: 2 },
    { prompt: [{ text: "The pond at dusk." }], duration: 3 },
  ],
};

/**
 * One generation, standing alone.
 * @param node - Its fields beyond the defaults.
 * @returns What the model sends.
 */
function alone(node: Partial<Sent["nodes"][number]>): Sent {
  return {
    nodes: [{ role: "generate", type: "image", name: "Portrait", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "A portrait." }], ...node }],
    edges: [],
    rationale: "r",
  };
}

describe("a tweak blank in a generate node's words", () => {
  it("is refused on a node that names no template, naming the blank", () => {
    const verdict = verdictFor(alone({ prompt: [{ text: "A herbalist girl, drawn in " }, BLANK, { text: "." }] }));
    expect(verdict).toMatchObject({ ok: false, refusal: "template-tweak-unfilled" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`"${LOOK}"`);
  });

  it("is refused in a shot of a multi-shot node that names no template", () => {
    const verdict = verdictFor(alone(SHOT_BLANK));
    expect(verdict).toMatchObject({ ok: false, refusal: "template-tweak-unfilled" });
  });

  it("is refused on a template's node when the agent wrote the blank itself", () => {
    const sent: Sent = {
      nodes: [
        {
          role: "generate",
          type: "image",
          name: "Character design",
          template: { id: "character-design-from-text", key: "design" },
          prompt: [{ text: "A full-body character design of a fox girl in a 3D cartoon style, wearing " }, BLANK, { text: "." }],
        },
        {
          role: "generate",
          type: "image",
          name: "Sheet",
          template: { id: "character-design-from-text" },
          prompt: [{ slot: { kind: "note", label: "Generate Character design first" } }, { text: "A character sheet of " }, { ref: 0 }, { text: ": the fox girl, a herbalist, 12, curious, brave, kind." }],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "r",
      groupName: "Fox girl",
    };
    // Guards the case itself: the same proposal with the blank written stands.
    const filled = { ...sent, nodes: sent.nodes.map((node, i) => (i === 0 ? { ...node, prompt: [{ text: "A full-body character design of a fox girl in a 3D cartoon style, wearing a red coat." }] } : node)) };
    expect(verdictFor(filled)).toEqual({ ok: true });
    const verdict = verdictFor(sent);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-tweak-unfilled" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`"${LOOK}"`);
  });

  it("leaves a generation whose words hold no blank standing", () => {
    expect(verdictFor(alone({ prompt: [{ text: "A herbalist girl, drawn in ink wash." }] }))).toEqual({ ok: true });
  });

  it("leaves a blank on a written node, which generates nothing, to the user", () => {
    const verdict = verdictFor({
      nodes: [
        { role: "written", type: "text", name: "Caption", prompt: [{ text: "Made by " }, BLANK] },
        { role: "generate", type: "image", name: "Portrait", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "A herbalist girl, drawn in ink wash." }] },
      ],
      edges: [],
      rationale: "r",
      groupName: "Post",
    });
    expect(verdict).toEqual({ ok: true });
  });
});

/**
 * The tool answers through `answerFor`, not `verdictFor`: what the card shows
 * and the canvas places is that answer, so a blank has to be held there too.
 */
describe("a tweak blank on the tool's own path", () => {
  it("is not placed on a node that names no template, naming the blank", () => {
    const answer = answerFor(alone({ prompt: [{ text: "A herbalist girl, drawn in " }, BLANK, { text: "." }] }));
    expect(answer).toMatchObject({ placed: false });
    expect(answer.placed ? "" : answer.reason).toContain(`"${LOOK}"`);
  });

  it("is not placed from a shot of a multi-shot node that names no template, naming the blank", () => {
    const answer = answerFor(alone(SHOT_BLANK));
    expect(answer).toMatchObject({ placed: false });
    expect(answer.placed ? "" : answer.reason).toContain(`"${LOOK}"`);
  });

  it("places the same generation once its words hold no blank", () => {
    expect(answerFor(alone({ prompt: [{ text: "A herbalist girl, drawn in ink wash." }] }))).toMatchObject({ placed: true });
  });
});
