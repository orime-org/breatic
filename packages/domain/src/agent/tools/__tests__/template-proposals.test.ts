// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The propose tool takes a template on a generate node and judges the node it
 * expands into (inner#977).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, promptTextOf, setLocale, templatePrompt } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { answerFor, inputSchema, makeProposeCanvasAction } from "../propose-canvas-action.js";

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
      { role: "generate", type: "image", name: "Storyboard", template },
    ],
    edges: [{ fromIndex: 0, toIndex: 1 }],
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
    expect(answer.nodes[1]?.prompt?.find((s) => s.slot)?.slot?.kind).toBe("asset");
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
      expect(said).toContain(promptTextOf(templatePrompt(template)));
    }
    expect(said).toContain("故事内容");
    setLocale("en");
  });

  it("tells the agent to keep the reference marks when it rewrites a template prompt", () => {
    expect(makeProposeCanvasAction().description).toMatch(/keep(ing)? every \[📎/i);
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
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('"kind":"asset"') });
  });

  it("is placed when a material mark mentions it", () => {
    const answer = answerFor(
      withPrompt([
        { text: "Use " },
        { slot: { kind: "asset", label: "character reference", note: "Put the photo in the empty node" } },
        { text: " as the reference. A 5x5 storyboard." },
      ]),
    );
    expect(answer.placed).toBe(true);
  });

  it("holds a proposal without a template to the same rule", () => {
    const answer = answerFor(withPrompt([{ text: "A 5x5 storyboard of the character." }], false));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('"kind":"asset"') });
  });
});

describe("the template prompts the agent is shown inside a request", () => {
  it("are in the request's language, which the turn pins rather than the process", async () => {
    const { runWithLocale } = await import("@breatic/core");
    const { buildAgentConfig } = await import("@domain/agent/agent-config.js");
    const [grid] = GENERATION_TEMPLATES;
    if (!grid) throw new Error("no template");
    setLocale("en");
    const said = runWithLocale("ja", () => buildAgentConfig({}).tools["propose_canvas_action"]?.description ?? "");
    const japanese = runWithLocale("ja", () => promptTextOf(templatePrompt(grid)));
    expect(japanese).not.toBe(promptTextOf(templatePrompt(grid)));
    expect(said).toContain(japanese);
  });
});

describe("empty nodes counted by the place their mark takes", () => {
  /**
   * A first-frame slot node listed before a pool node, both empty, feeding
   * Kling O3 image-to-video, with the given number of material marks.
   * @param marks - How many asset marks the prompt carries.
   * @returns The proposal as the agent sends it.
   */
  function slotThenPool(marks: number): Parameters<typeof answerFor>[0] {
    const asset = (label: string): { slot: { kind: "asset"; label: string; note: string } } => ({
      slot: { kind: "asset", label, note: label },
    });
    const prompt = [
      { text: "She walks forward. " },
      ...(marks >= 2 ? [asset("first frame"), { text: " opens it. " }] : []),
      asset("character"),
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
        { fromIndex: 0, toIndex: 2 },
        { fromIndex: 1, toIndex: 2 },
      ],
      rationale: "A clip from a first frame, keeping the character.",
      groupName: "Clip",
    };
  }

  it("refuses one mark when the pool node comes second, since that mark lands on the slot", () => {
    const answer = answerFor(slotThenPool(1));
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining("2 material mark") });
  });

  it("places a mark for each place in order", () => {
    const answer = answerFor(slotThenPool(2));
    expect(answer).toMatchObject({ placed: true });
  });
});
