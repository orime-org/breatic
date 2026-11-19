// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template styles for the agent (inner#1817, CAP-10): reading a styled
 * template lists its styles, or gives a picked style's words after the node's
 * own; a node sent with no words is told it also takes a style paragraph.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { mergeLocaleMessages, setLocale, templateStyleSet, type GenerationTemplate } from "@breatic/shared";

import { describeTemplate } from "../get-generation-template.js";
import { proposeCanvasAction } from "../propose-canvas-action.js";
import { nodeLabel } from "../proposal-refusals.js";
import { expandAt, templatePlace, templateSegmentsText } from "../template-expansion.js";

const SET = templateStyleSet("film-styles");
const FIRST = SET.styles[0]?.id ?? "";
const SECOND = SET.styles[1]?.id ?? "";

/** A one-node template that takes film styles. */
const STYLED: GenerationTemplate = {
  id: "styled-fixture",
  anchor: "still",
  styles: "film-styles",
  nodes: [{ key: "still", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: {}, styleWords: "still" }],
  edges: [],
  inputs: [{ key: "subject", type: "image" }],
  steps: [],
  agentNote: "a styled fixture",
  goal: "character",
  triggers: { asks: ["a styled fixture"], offerWhen: [] },
};

beforeEach(() => {
  loadLocales();
  setLocale("en");
  mergeLocaleMessages("en", {
    canvas: {
      template: {
        "styled-fixture": { name: "Styled", prompt: "Redraw [📎 Subject].", input: { subject: { name: "Subject", note: "Add one." } } },
        styleSet: {
          "film-styles": {
            style: {
              [FIRST]: { name: "First style", still: "Thick oil paint in ridges. Warm gold." },
              [SECOND]: { name: "Second style", still: "Black ink cut into wood." },
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

describe("reading a styled template", () => {
  it("lists every style of its set with its name and the first sentence of the set's first part when no style is given", () => {
    const text = describeTemplate(STYLED);
    expect(text).toContain("pass style to read the words for one");
    expect(text).toContain(`${FIRST} ("First style"): Thick oil paint in ridges.`);
    expect(text).not.toContain("Warm gold.");
    expect(text).toContain(`${SECOND} ("Second style"): Black ink cut into wood.`);
  });

  it("gives the picked style's words after the node's own", () => {
    const text = describeTemplate(STYLED, FIRST);
    expect(text).toContain(JSON.stringify({ text: "\n\nThick oil paint in ridges. Warm gold." }));
    expect(text).not.toContain("pass style to read the words for one");
    expect(templateSegmentsText(STYLED, "still", FIRST)).toContain("Warm gold.");
    expect(templateSegmentsText(STYLED, "still")).not.toContain("Warm gold.");
  });

  it("names the set's styles when the style given is not one of them", () => {
    const text = describeTemplate(STYLED, "no-such-style");
    expect(text).toContain('Style "no-such-style" is not one of this template\'s');
    expect(text).toContain(FIRST);
  });
});

describe("a styled template's node sent with no words", () => {
  it("is told it also takes one style's paragraph and where to read it", () => {
    const place = templatePlace({ id: STYLED.id }, { role: "generate", type: "image", name: "Still" }, [STYLED]);
    if ("refusal" in place) throw new Error(place.reason);
    const out = expandAt(place, { role: "generate", type: "image", name: "Still" }, nodeLabel([{ name: "Still" }], 0));
    expect(out).toMatchObject({ ok: false, refusal: "template-no-prompt" });
    expect(out.ok ? "" : out.reason).toContain("followed by one style's paragraph: read it with get_generation_template and style");
  });
});

describe("the template index", () => {
  it("says a styled template takes one of its set's styles, by category, and where to read them", () => {
    const description = String(proposeCanvasAction.description);
    const line = description.split(" | ").find((one) => one.startsWith("film-style-still ")) ?? "";
    expect(line).toContain(`Takes one of ${String(SET.styles.length)} styles (painting, drawing, print, cartoon, photo, craft); read them with get_generation_template.`);
    const plain = description.split(" | ").find((one) => one.startsWith("era-walkthrough-montage ")) ?? "";
    expect(plain).not.toContain("Takes one of");
  });
});
