// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent reads a template in full before proposing it (inner#1807): the
 * proposal tool's description indexes the templates in a line each, and this
 * tool returns one template's nodes, wiring, inputs and prompts in the
 * reader's language, how to send them, and the craft that fits its nodes.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, setLocale, type GenerationTemplate } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { templateSegmentsText as shown } from "@domain/agent/tools/template-expansion.js";

import { renderTemplateSegment } from "../get-generation-template.js";
import { CANVAS_TOOLS, TOOL_MAP } from "../index.js";
import { TEMPLATE_CRAFT } from "../template-craft.js";

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  setLocale("en");
  restoreProcessEnv();
});

/** The tool as a turn is handed it. */
const readTool = (): { description?: unknown; inputSchema: unknown; metadata?: unknown; execute?: (input: unknown, options: object) => Promise<unknown> } => {
  const build = TOOL_MAP["get_generation_template"];
  if (build === undefined) throw new Error("get_generation_template is not registered");
  return build() as unknown as ReturnType<typeof readTool>;
};

/**
 * What the tool answers for one template id.
 * @param id - The template id.
 * @returns The text it returns.
 */
async function read(id: string): Promise<string> {
  const { execute } = readTool();
  if (execute === undefined) throw new Error("no execute");
  return String(await execute({ id }, {}));
}

/**
 * A registered template by id.
 * @param id - The id.
 * @returns The template.
 */
function byId(id: string): GenerationTemplate {
  const template = GENERATION_TEMPLATES.find((one) => one.id === id);
  if (template === undefined) throw new Error(`no template ${id}`);
  return template;
}

describe("get_generation_template", () => {
  it("is a canvas tool, offered right before the proposal tool it serves", () => {
    const at = CANVAS_TOOLS.indexOf("get_generation_template");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CANVAS_TOOLS[at + 1]).toBe("propose_canvas_action");
  });

  it("takes only a registered template id", () => {
    const schema = readTool().inputSchema as { safeParse: (value: unknown) => { success: boolean } };
    for (const template of GENERATION_TEMPLATES) expect(schema.safeParse({ id: template.id }).success, template.id).toBe(true);
    expect(schema.safeParse({ id: "no-such-template" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("says in its description to read a template before proposing it, and runs under its own line", () => {
    const { description, metadata } = readTool();
    expect(String(description)).toMatch(/before propos/i);
    expect(metadata).toEqual({ runningLine: "chat.tool.readingTemplate" });
  });

  it("returns every registered template's full text, the prompts in the reader's language", async () => {
    for (const locale of ["en", "zh-CN"]) {
      setLocale(locale);
      for (const template of GENERATION_TEMPLATES) {
        const said = await read(template.id);
        expect(said, `${template.id} ${locale}`).toContain(renderTemplateSegment(template));
        expect(said, `${template.id} ${locale}`).toContain(shown(template));
      }
    }
    setLocale("en");
  });

  it("says how to send a template's nodes", async () => {
    const said = await read("storyboard-grid-25");
    expect(said).toContain("To use one, send each of its nodes as a node");
    expect(said).toContain("{ id } in template on the anchor, { id, key } on each other node");
  });

  it("adds the craft that fits the template: video craft for a video, character craft for a character goal", async () => {
    const scene = await read("single-view-refs-scene");
    expect(scene).toContain(TEMPLATE_CRAFT.all);
    expect(scene).toContain(TEMPLATE_CRAFT.video);
    expect(scene).toContain(TEMPLATE_CRAFT.character);
    const grid = await read("storyboard-grid-25");
    expect(grid).toContain(TEMPLATE_CRAFT.all);
    expect(grid).not.toContain(TEMPLATE_CRAFT.video);
    expect(grid).not.toContain(TEMPLATE_CRAFT.character);
    const bible = await read("character-bible");
    expect(bible).toContain(TEMPLATE_CRAFT.character);
    expect(bible).not.toContain(TEMPLATE_CRAFT.video);
  });

  it("has words in every craft section", () => {
    for (const craft of Object.values(TEMPLATE_CRAFT)) expect(craft.trim().length).toBeGreaterThan(0);
  });

  it("lets a character reference lend its rendering, which the sheet prompts ask to keep", () => {
    expect(TEMPLATE_CRAFT.character).toMatch(/rendering/);
    expect(TEMPLATE_CRAFT.character).not.toMatch(/lends only/);
  });
});

describe("a multi-node template's full text", () => {
  it("shows the single-view scene's wiring and @s each view and the original by what is wired in", () => {
    const said = renderTemplateSegment(byId("single-view-refs-scene"));
    for (const view of ["front", "side", "back"]) {
      expect(said).toContain(`"${view}" into "result" by "pool"`);
      expect(said).toContain(`{"ref": <index of the node wired in for node "${view}">}`);
    }
    expect(said).toContain('"reference" (image) into "front", "side", "back", "result"');
    expect(said).toContain('{"ref": <index of the node wired in for input "reference">}');
    expect(said).toContain('"result" (anchor): generate video, t2v, seedance-2.5-text-to-video');
  });

  it("shows the designed character drawn into the sheet with a note to generate it first", () => {
    const said = renderTemplateSegment(byId("character-design-from-text"));
    expect(said).toContain('"design" into "result" by "pool"');
    expect(said).toContain('{"ref": <index of the node wired in for node "design">}');
    expect(said).toContain('"kind":"note"');
    expect(said).toContain('"design": generate image, t2i, gpt-image-2.5-sunburst-text-to-image');
  });
});
