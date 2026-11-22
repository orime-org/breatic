// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The agent's reading of a style set built unlike the film styles (inner#1817, CAP-10): a set with no categories
 * whose first part is not `still` gets an index line with no bracket, and its styles are introduced by the first
 * sentence of that first part.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocales } from "@breatic/core";
import type * as SharedModule from "@breatic/shared";
import { mergeLocaleMessages, setLocale, type GenerationTemplate, type TemplateStyleSet } from "@breatic/shared";

const { HIT, HIT_TEMPLATE } = vi.hoisted(() => {
  const set = {
    id: "hit-fixture",
    styles: [{ id: "flash" }, { id: "invert" }],
    parts: ["hit"],
    thumbnails: false,
  };
  const template = {
    id: "hit-template-fixture",
    anchor: "hit",
    // Shared reads the node's own words through the sets it registers, so the template names a registered one and
    // its node takes none of its words; the agent's side sees the set below through the mocked templateStylesOf.
    styles: "film-styles",
    nodes: [{ key: "hit", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: {} }],
    edges: [],
    inputs: [{ key: "subject", type: "image" }],
    steps: [],
    agentNote: "a set without categories",
    goal: "character",
    triggers: { asks: ["a hit fixture"], offerWhen: [] },
  };
  return { HIT: set, HIT_TEMPLATE: template };
});

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedModule>();
  return {
    ...actual,
    GENERATION_TEMPLATES: [...actual.GENERATION_TEMPLATES, HIT_TEMPLATE],
    templateStylesOf: (template: GenerationTemplate): TemplateStyleSet | undefined =>
      template.id === HIT_TEMPLATE.id ? HIT : actual.templateStylesOf(template),
  };
});

import { describeTemplate } from "../get-generation-template.js";
import { proposeCanvasAction } from "../propose-canvas-action.js";

beforeEach(() => {
  loadLocales();
  setLocale("en");
  mergeLocaleMessages("en", {
    canvas: {
      template: {
        [HIT_TEMPLATE.id]: { name: "Hit", prompt: "Strike [📎 Subject].", input: { subject: { name: "Subject", note: "Add one." } } },
        styleSet: {
          [HIT.id]: {
            style: {
              flash: { name: "Flash", hit: "A white flash. Then black." },
              invert: { name: "Invert", hit: "Colours swap at once. Then back." },
            },
          },
        },
      },
    },
  });
});

afterAll(() => {
  loadLocales();
  setLocale("en");
});

describe("a style set with no categories and no still part", () => {
  it("writes its index line with no bracket", () => {
    const line = String(proposeCanvasAction.description).split(" | ").find((one) => one.startsWith(`${HIT_TEMPLATE.id} `)) ?? "";
    expect(line).toContain("Takes one of 2 styles; read them with get_generation_template.");
  });

  it("introduces each style by the first sentence of the set's first part", () => {
    const text = describeTemplate(HIT_TEMPLATE as GenerationTemplate);
    expect(text).toContain('flash ("Flash"): A white flash.');
    expect(text).toContain('invert ("Invert"): Colours swap at once.');
    expect(text).not.toContain("Then black.");
  });
});
