// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The propose tool takes a template on a generate node and judges the node it
 * expands into (inner#977).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { GENERATION_TEMPLATES } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { answerFor, inputSchema, proposeCanvasAction } from "../propose-canvas-action.js";

beforeEach(() => {
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
      expect(proposeCanvasAction.description).toContain(template.id);
    }
    expect(proposeCanvasAction.description).toMatch(/storyboard-grid-25[^.]*1 reference/);
  });
});
