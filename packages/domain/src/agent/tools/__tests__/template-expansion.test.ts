// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposed node naming a template and one of its keys starts from that
 * node's defaults and keeps whatever the agent wrote (inner#977, inner#1345
 * design 6.7 step 2); a generate node's prompt is always the agent's own
 * (inner#1315).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";

import type { GenerationTemplate, ProposalNode } from "@breatic/shared";

import { nodeLabel, type NodeLabel } from "@domain/agent/tools/proposal-refusals.js";
import { expandAt, templatePlace, type TemplateExpansion } from "@domain/agent/tools/template-expansion.js";

import { EDIT, FIXTURES, SHOT_MODEL, loadFixtureLocales } from "./template-fixtures.js";

beforeEach(() => {
  loadFixtureLocales();
});

afterAll(() => {
  loadLocales();
});

const PROMPT = [{ text: "A sheet of " }, { ref: 1 }, { text: " in two views." }];

/** The node as a fix names it. */
const AT = nodeLabel([{ name: "Sheet" }], 0);

/** A template tag as the agent writes it. */
type Tag = { id: string; key?: string };

/**
 * A node naming a template, with what the test gives it.
 * @param template - The tag.
 * @param extra - Fields the agent wrote.
 * @returns The node as the agent sent it.
 */
function named(template: Tag, extra: Partial<ProposalNode> = {}): ProposalNode & { template: Tag } {
  return { role: "generate", type: "image", name: "Sheet", template, prompt: PROMPT, ...extra };
}

/**
 * Reads a node's tag and fills it, as the tool does for each node it is sent.
 * @param node - The node as the agent sent it.
 * @param at - The node, as a fix names it.
 * @param templates - The registry.
 * @returns The expanded node, or the refusal.
 */
function expandTemplate(node: ProposalNode & { template: Tag }, at: NodeLabel, templates?: readonly GenerationTemplate[]): TemplateExpansion {
  const { template: tag, ...rest } = node;
  const place = templatePlace(tag, rest, templates);
  return "ok" in place ? place : expandAt(place, rest, at);
}

const SHEET_ANCHOR: Tag = { id: "fixture-sheet" };
const SKETCH: Tag = { id: "fixture-sheet", key: "sketch" };

describe("expandTemplate", () => {
  it("fills the anchor's mode, model and params the agent left out", () => {
    const out = expandTemplate(named(SHEET_ANCHOR), AT, FIXTURES);
    expect(out).toEqual({
      ok: true,
      node: {
        role: "generate",
        type: "image",
        name: "Sheet",
        mode: "i2i",
        model: EDIT,
        params: { aspect_ratio: "16:9", resolution: "4k" },
        prompt: PROMPT,
      },
    });
  });

  it("reads the anchor's key written out the same as no key", () => {
    const keyed = expandTemplate(named({ id: "fixture-sheet", key: "sheet" }), AT, FIXTURES);
    expect(keyed).toMatchObject({ ok: true, node: { mode: "i2i", model: EDIT } });
    expect(keyed).toEqual(expandTemplate(named(SHEET_ANCHOR), AT, FIXTURES));
  });

  it("fills a node other than the anchor from its own key's defaults", () => {
    const out = expandTemplate(named(SKETCH, { name: "Sketch" }), AT, FIXTURES);
    expect(out).toEqual({
      ok: true,
      node: { role: "generate", type: "image", name: "Sketch", mode: "i2i", model: EDIT, params: { aspect_ratio: "1:1" }, prompt: PROMPT },
    });
  });

  it("fills a resource node's resource path, asking no prompt of it", () => {
    const out = expandTemplate({ role: "source", type: "image", name: "Palette", template: { id: "fixture-sheet", key: "palette" } }, AT, FIXTURES);
    expect(out).toEqual({
      ok: true,
      node: { role: "source", type: "image", name: "Palette", resource: "templates/fixture-sheet/palette.png" },
    });
  });

  it("lays the agent's params over the template's while mode and model stay the template's", () => {
    const out = expandTemplate(named(SHEET_ANCHOR, { params: { resolution: "2k" } }), AT, FIXTURES);
    expect(out.ok && out.node.params).toEqual({ aspect_ratio: "16:9", resolution: "2k" });
  });

  it("carries none of the template's params once the agent picks another model", () => {
    const out = expandTemplate(named(SKETCH, { model: "gpt-image-2.5-sunburst-edit", params: { quality: "high" } }), AT, FIXTURES);
    expect(out.ok && out.node.model).toBe("gpt-image-2.5-sunburst-edit");
    expect(out.ok && out.node.params).toEqual({ quality: "high" });
  });

  it("carries none of the template's params once the agent picks another mode", () => {
    const out = expandTemplate(named(SHEET_ANCHOR, { mode: "t2i", model: "nano-banana-2" }), AT, FIXTURES);
    expect(out.ok).toBe(true);
    expect(out.ok && out.node.params).toBeUndefined();
  });

  it("keeps the prompt the agent wrote", () => {
    const prompt = [{ text: "a sheet of a cat" }];
    const out = expandTemplate(named(SHEET_ANCHOR, { prompt }), AT, FIXTURES);
    expect(out.ok && out.node.prompt).toEqual(prompt);
  });

  it("refuses a generate node with no prompt, giving that node's own template words with a ref placeholder for each reference", () => {
    const out = expandTemplate(named(SKETCH, { name: "Sketch", prompt: undefined }), AT, FIXTURES);
    expect(out).toMatchObject({ ok: false, refusal: "template-no-prompt" });
    const reason = out.ok ? "" : out.reason;
    expect(reason).toContain("sends no prompt");
    expect(reason).toContain("A rough sketch of ");
    expect(reason).not.toContain("side by side on one sheet");
    expect(reason).toContain('{"ref": <index of the node wired in');
    expect(reason).not.toContain("📎");
  });

  it("refuses a multi_shot generate node with no shots as sending no prompt", () => {
    const out = expandTemplate({ role: "generate", type: "video", name: "Clip", template: { id: "fixture-shots" } }, AT, FIXTURES);
    expect(out).toMatchObject({ ok: false, refusal: "template-no-prompt" });
  });

  it("takes a multi_shot generate node's shots as its prompt", () => {
    const shots = [{ prompt: [{ text: "She walks." }], duration: 5 }];
    const out = expandTemplate({ role: "generate", type: "video", name: "Clip", template: { id: "fixture-shots" }, shots }, AT, FIXTURES);
    expect(out).toEqual({
      ok: true,
      node: { role: "generate", type: "video", name: "Clip", mode: "multi_shot", model: SHOT_MODEL, params: {}, shots },
    });
  });

  it("refuses a template the registry it is given does not have, naming the ones it does", () => {
    const out = expandTemplate(named({ id: "no-such" }), AT, FIXTURES);
    expect(out).toMatchObject({ ok: false, refusal: "template-unknown", reason: 'No template "no-such". Templates: fixture-sheet, fixture-solo, fixture-steps, fixture-shots.' });
  });

  it("reads the registry when no other is given", () => {
    const out = expandTemplate(named({ id: "storyboard-grid-25" }), AT);
    expect(out).toMatchObject({ ok: true, node: { mode: "i2i", model: EDIT, params: { aspect_ratio: "1:1", resolution: "4k" } } });
  });
});
