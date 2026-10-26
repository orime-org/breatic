// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The propose tool takes a template on a generate node and judges the node it
 * expands into (inner#977).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@domain/agent/model-picture-capability.js", () => ({ resolveModelPictureCapability: vi.fn(async () => true) }));
vi.mock("@domain/agent/model-context-window.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveModelContextWindow: vi.fn(async () => 1_000_000),
}));

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, setLocale } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { templateSegmentsText as shown } from "@domain/agent/tools/template-expansion.js";

import { answerFor, makeProposeCanvasAction } from "../propose-canvas-action.js";
import { inputSchema } from "../proposal-input.js";

const NOTE = { slot: { kind: "note" as const, label: "Put the character's picture in Character first" } };

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * An empty picture wired into a generation that names a template.
 * @param template - The template id.
 * @returns The proposal as the agent sends it.
 */
function proposalWith(template: string): Parameters<typeof answerFor>[0] {
  return {
    nodes: [
      { role: "source", type: "image", name: "Character" },
      { role: "generate", type: "image", name: "Storyboard", template, prompt: [NOTE, { text: "A 5x5 storyboard of " }, { ref: 0 }, { text: "." }] },
    ],
    edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    rationale: "A 25-panel storyboard of the character.",
    groupName: "Storyboard",
  };
}

describe("templates in proposals", () => {
  it("accepts a template on a node", () => {
    expect(inputSchema.safeParse(proposalWith("storyboard-grid-25")).success).toBe(true);
  });

  it("places the node the template expands into", () => {
    const answer = answerFor(proposalWith("storyboard-grid-25"));
    expect(answer.placed).toBe(true);
    if (!answer.placed) return;
    expect(answer.nodes[1]).toMatchObject({
      mode: "i2i",
      model: "nano-banana-pro-edit-ultra",
      params: { aspect_ratio: "1:1", resolution: "4k" },
    });
    expect(answer.nodes[1]?.prompt?.some((s) => s.ref === 0)).toBe(true);
  });

  it("refuses a template it does not have", () => {
    const answer = answerFor(proposalWith("no-such"));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining("No template") });
  });

  it("names every template and how many references each takes in its description", () => {
    for (const template of GENERATION_TEMPLATES) {
      expect(makeProposeCanvasAction().description).toContain(template.id);
    }
    expect(makeProposeCanvasAction().description).toMatch(/storyboard-grid-25[^.]*1 reference/);
  });

  it("shows each template's prompt in the reader's language, so the agent can rewrite it rather than start over", () => {
    setLocale("zh-CN");
    const said = makeProposeCanvasAction().description ?? "";
    for (const template of GENERATION_TEMPLATES) {
      expect(said).toContain(shown(template));
    }
    expect(said).toContain("故事内容");
    setLocale("en");
  });

  it("shows each reference in a template's prompt as the ref of the node wired in for it", () => {
    const said = makeProposeCanvasAction().description ?? "";
    expect(said).toContain('{"ref": <index of the node wired in for');
    expect(said).not.toContain('"kind":"asset"');
  });
});

describe("a template drawing on work generated upstream", () => {
  /**
   * A character generated first, wired into a storyboard from the template.
   * @param prompt - The storyboard prompt the agent sends.
   * @returns The proposal as the agent sends it.
   */
  function chained(
    prompt: NonNullable<Parameters<typeof answerFor>[0]["nodes"][number]["prompt"]>,
  ): Parameters<typeof answerFor>[0] {
    return {
      nodes: [
        { role: "generate", type: "image", name: "Character", mode: "t2i", model: "nano-banana-2", prompt: [{ text: "A young courier in a red coat." }] },
        { role: "generate", type: "image", name: "Storyboard", template: "storyboard-grid-25", prompt },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "Make the character, then a storyboard of it.",
      groupName: "Storyboard",
    };
  }

  it("is placed with a ref to the generated character and a note to generate it first", () => {
    const answer = answerFor(
      chained([
        { slot: { kind: "note", label: "Generate Character first" } },
        { text: "Use " },
        { ref: 0 },
        { text: " as the reference. A 5x5 storyboard of a courier crossing the city." },
      ]),
    );
    expect(answer.placed).toBe(true);
  });

  it("is refused with no prompt of its own, giving the template's words with a ref placeholder for the character", () => {
    const sent = chained([]);
    const answer = answerFor({ ...sent, nodes: [sent.nodes[0]!, { role: "generate", type: "image", name: "Storyboard", template: "storyboard-grid-25" }] });
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('{"ref": <index of the node wired in for') });
  });
});

describe("an empty node wired into a reference pool", () => {
  /**
   * The template proposal with the agent's own prompt on the generate node.
   * @param prompt - The prompt the agent wrote.
   * @param template - Whether the node names the template.
   * @returns The proposal as the agent sends it.
   */
  function withPrompt(
    prompt: NonNullable<Parameters<typeof answerFor>[0]["nodes"][number]["prompt"]>,
    template = true,
  ): Parameters<typeof answerFor>[0] {
    const sent = proposalWith("storyboard-grid-25");
    const generate = template
      ? { ...sent.nodes[1]!, prompt }
      : { role: "generate" as const, type: "image" as const, name: "Storyboard", mode: "i2i", model: "nano-banana-pro-edit-ultra", prompt };
    return { ...sent, nodes: [sent.nodes[0]!, generate] };
  }

  it("is refused when the prompt names it only in words, since the picture put there would not be sent", () => {
    const answer = answerFor(withPrompt([{ text: "Use [📎 character reference] as the reference. A 5x5 storyboard." }]));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('types 1 mark(s) into its words as text: "[📎 character reference]". A mark works only as a segment of its own, with the text segments kept to plain words: {"ref": <index>} for a node.') });
  });

  it("is placed when a ref mentions it", () => {
    const answer = answerFor(
      withPrompt([NOTE, { text: "Use " }, { ref: 0 }, { text: " as the reference. A 5x5 storyboard." }]),
    );
    expect(answer.placed).toBe(true);
  });

  it("holds a proposal without a template to the same rule", () => {
    const answer = answerFor(withPrompt([NOTE, { text: "A 5x5 storyboard of the character." }], false));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringMatching(/"Character".*ref/) });
  });
});

describe("the template prompts the agent is shown inside a request", () => {
  it("are in the request's language, which the turn pins rather than the process", async () => {
    const { runWithLocale } = await import("@breatic/core");
    const { buildAgentConfig } = await import("@domain/agent/agent-config.js");
    const [grid] = GENERATION_TEMPLATES;
    if (!grid) throw new Error("no template");
    setLocale("en");
    const said = await runWithLocale("ja", async () => (await buildAgentConfig({ basePrompt: "base" })).tools["propose_canvas_action"]?.description ?? "");
    const japanese = runWithLocale("ja", () => shown(grid));
    expect(japanese).not.toBe(shown(grid));
    expect(said).toContain(japanese);
  });
});

describe("empty nodes counted, a slot's and an unused kind's left out", () => {
  /**
   * A first-frame slot node listed before a pool node, both empty, feeding
   * Kling O3 image-to-video, the pool node @'d by the given number of refs.
   * @param refs - How many refs to the pool node the prompt carries.
   * @returns The proposal as the agent sends it.
   */
  function slotThenPool(refs: number): Parameters<typeof answerFor>[0] {
    const prompt = [
      { slot: { kind: "note" as const, label: "Pick the first frame into the image slot" } },
      { slot: { kind: "note" as const, label: "Put the character in Character first" } },
      { text: "She walks forward. " },
      ...(refs >= 2 ? [{ ref: 1 }, { text: " looks back. " }] : []),
      { ref: 1 },
      { text: " stays the same." },
    ];
    return {
      nodes: [
        { role: "source", type: "image", name: "First frame" },
        { role: "source", type: "image", name: "Character" },
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "i2v",
          model: "kling-video-o3-4k-image-to-video",
          prompt,
        },
      ],
      edges: [
        { fromIndex: 0, toIndex: 2, into: "image" },
        { fromIndex: 1, toIndex: 2, into: "pool" },
      ],
      rationale: "A clip from a first frame, keeping the character.",
      groupName: "Clip",
    };
  }

  it("places one ref for the pool node and a note for each empty node", () => {
    expect(answerFor(slotThenPool(1))).toMatchObject({ placed: true });
  });

  it("places the pool node @'d twice", () => {
    const answer = answerFor(slotThenPool(2));
    expect(answer).toMatchObject({ placed: true });
  });

  /**
   * A picture and a voice, both empty, wired into a reference-to-video node
   * whose pool takes pictures only, in the given order; a second node in the
   * group takes the voice.
   * @param voiceFirst - Whether the voice is listed before the picture.
   * @returns The proposal as the agent sends it.
   */
  function pictureAndVoice(voiceFirst: boolean): Parameters<typeof answerFor>[0] {
    const picture = { role: "source" as const, type: "image" as const, name: "Character" };
    const voice = { role: "source" as const, type: "audio" as const, name: "Voice" };
    const picked = voiceFirst ? 1 : 0;
    const note = { slot: { kind: "note" as const, label: "Put the character in Character first" } };
    return {
      nodes: [
        voiceFirst ? voice : picture,
        voiceFirst ? picture : voice,
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "ref",
          model: "happyhorse-1.1-reference-to-video",
          prompt: [note, { ref: picked }, { text: " walks through the rain." }],
        },
        {
          role: "generate",
          type: "video",
          name: "Talking",
          mode: "ref",
          model: "wan-3.0-reference-to-video",
          prompt: [note, { slot: { kind: "note" as const, label: "Put the voice in Voice first" } }, { ref: picked }, { text: " speaks to camera in " }, { ref: voiceFirst ? 0 : 1 }, { text: "." }],
        },
      ],
      edges: [2, 3].flatMap((toIndex) => [
        { fromIndex: voiceFirst ? 0 : 1, toIndex },
        { fromIndex: voiceFirst ? 1 : 0, toIndex, into: "pool" },
      ]),
      rationale: "Two clips of the character.",
      groupName: "Clips",
    };
  }

  it("needs one ref for the picture whichever order the voice is listed in", () => {
    expect(answerFor(pictureAndVoice(false))).toMatchObject({ placed: true });
    expect(answerFor(pictureAndVoice(true))).toMatchObject({ placed: true });
  });
});
