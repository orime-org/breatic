// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The agent reads a template in full before proposing it (inner#1807): the
 * proposal tool's description indexes the templates in a line each, and this
 * tool returns one template's nodes, wiring, inputs and prompts in the
 * user's language, how to send them, and the craft that fits its nodes.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, formatCredits, setLocale, type GenerationTemplate } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import { estimateModelCredits } from "@domain/model-catalog/model-catalog.js";

import { templateSegmentsText as shown } from "@domain/agent/tools/template-expansion.js";

import { describeTemplate } from "../get-generation-template.js";
import { CANVAS_TOOLS, TOOL_MAP } from "../index.js";
import { TEMPLATE_CRAFT, templateCraft } from "../template-craft.js";

import { loadFixtureLocales, SLOTTED, STANDALONE } from "./template-fixtures.js";

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

  it("returns every registered template's full text, the prompts in the user's language", async () => {
    for (const locale of ["en", "zh-CN"]) {
      setLocale(locale);
      for (const template of GENERATION_TEMPLATES) {
        const said = await read(template.id);
        expect(said, `${template.id} ${locale}`).toContain(describeTemplate(template));
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

  it("says to fill every tweak segment before sending, from the user's words or by asking, making takes first or choosing as the working rules say, and never to send one as it is (breatic#1361)", async () => {
    const said = await read("character-design-from-text");
    expect(said).toContain(
      "fill every tweak segment with words before you send it: from what the user said, or, for one their words leave open, after asking them, making takes first, or choosing, as your working rules say.",
    );
    expect(said).toContain("A template's tweak segment is never sent as it is.");
    expect(said).not.toContain("your own choice");
    expect(said).not.toContain("keep it for them");
  });

  it("asks for a character described in words alone, and leaves an unnamed style to the working rules rather than choosing one itself (breatic#1361)", async () => {
    const said = await read("character-design-from-text");
    expect(said).toContain("from the user's description as one full-body picture");
    expect(said).not.toContain("the user's description and style");
    expect(said).toContain(TEMPLATE_CRAFT.character);
    expect(TEMPLATE_CRAFT.character).not.toContain("When the user names no style");
  });

  it("adds the craft that fits the template: video craft for a video, character craft for a character goal", async () => {
    const scene = await read("single-view-refs-scene");
    expect(scene).toContain(TEMPLATE_CRAFT.picture);
    expect(scene).toContain(TEMPLATE_CRAFT.video);
    expect(scene).toContain(TEMPLATE_CRAFT.character);
    const grid = await read("storyboard-grid-25");
    expect(grid).toContain(TEMPLATE_CRAFT.picture);
    expect(grid).not.toContain(TEMPLATE_CRAFT.video);
    expect(grid).not.toContain(TEMPLATE_CRAFT.character);
    const bible = await read("character-bible");
    expect(bible).toContain(TEMPLATE_CRAFT.character);
    expect(bible).not.toContain(TEMPLATE_CRAFT.video);
  });

  it("lets a template put the text it asks for in the picture, labels, a title or lines of verse, and keeps out any other text", () => {
    expect(TEMPLATE_CRAFT.picture).toContain("put no text in the picture unless the template asks for it (labels, a title, lines of verse)");
  });

  it("lets a template set a cut rhythm faster than the beat every 2 to 3 seconds", () => {
    expect(TEMPLATE_CRAFT.video).toContain("a visible beat every 2 to 3 seconds unless the template sets its own cut rhythm");
  });

  it("has words in every craft section", () => {
    for (const craft of Object.values(TEMPLATE_CRAFT)) expect(craft.trim().length).toBeGreaterThan(0);
  });
});

describe("a multi-node template's full text", () => {
  it("shows the single-view scene's wiring and @s each view and the original by what is wired in", () => {
    const said = describeTemplate(byId("single-view-refs-scene"));
    for (const view of ["front", "side", "back"]) {
      expect(said).toContain(`"${view}" into "result" by "pool"`);
      expect(said).toContain(`{"ref": <index of the node wired in for node "${view}">}`);
    }
    expect(said).toContain('"reference" (image) into "front", "side", "back", "result"');
    expect(said).toContain('{"ref": <index of the node wired in for input "reference">}');
    expect(said).toContain('"result" (anchor): generate video, t2v, seedance-2.5-text-to-video');
  });

  it("shows the designed character drawn into the sheet with a note to generate it first", () => {
    const said = describeTemplate(byId("character-design-from-text"));
    expect(said).toContain('"design" into "result" by "pool"');
    expect(said).toContain('{"ref": <index of the node wired in for node "design">}');
    expect(said).toContain('"kind":"note"');
    expect(said).toContain('"design": generate image, t2i, gpt-image-2.5-sunburst-text-to-image');
  });
});

describe("the settings each generate node of a template runs at (breatic#1361)", () => {
  it("writes each generate node's params, so the agent sees the tier a template runs at", () => {
    for (const template of GENERATION_TEMPLATES) {
      const said = describeTemplate(template);
      for (const node of template.nodes) {
        if (node.role !== "generate") continue;
        for (const [name, value] of Object.entries(node.params ?? {})) {
          const written = new RegExp(`"?${name}"?\\s*[:=]\\s*${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
          expect(said, `${template.id} "${node.key}" ${name}`).toMatch(written);
        }
      }
    }
  });

  it("says a value written in a node's params wins over the template's", async () => {
    expect(await read("character-bible")).toMatch(/params[^.]*(?:wins?|overrides?|in place of)[^.]*template/i);
  });
});

describe("a template with a shot list (inner#1816)", () => {
  it("shows the quick tip as five shots in multi_shot, each with its seconds and segments, and says to send the shots", async () => {
    const said = await read("vertical-15s-quick-tip");
    expect(said).toContain('"result" (anchor): generate video, multi_shot, seedance-2.5-text-to-video, 5 shots');
    expect(said).toContain("shots: [");
    expect(said.match(/"duration": 3\b/g)).toHaveLength(5);
    expect(said).toContain('{"ref": <index of the node wired in for input "subject">}');
    expect(said).toContain("sends shots and no prompt");
    expect(said).toContain(describeTemplate(byId("vertical-15s-quick-tip")));
  });

  it("says a multi_shot node sends shots adding up to the duration written in its params, else the template's while it keeps the template's mode and model, and any other mode sends one prompt", async () => {
    const said = await read("vertical-15s-quick-tip");
    expect(said).toContain(
      "A node sent in multi_shot sends shots and no prompt, their durations adding up to the node's duration: " +
        "the one you write in its params, else the template's while the node keeps the template's mode and model; " +
        "on another mode or model, write one. " +
        "A node sent in any other mode sends a prompt, a template's shots written as one.",
    );
    expect(said).not.toContain("the template's while the node keeps the template's mode and model, otherwise one you set in its params");
    expect(said).not.toContain("For a node with shots");
    expect(said).not.toContain("each with the duration the template gives it");
  });

  it("writes no shot list for a template without shots", () => {
    for (const id of ["storyboard-grid-25", "single-view-refs-scene"]) {
      const said = describeTemplate(byId(id));
      expect(said, id).not.toContain("shots: [");
    }
  });
});

describe("what one apply of a template costs (inner#1816)", () => {
  /**
   * Each generate node's estimate at the template's own settings, priced
   * the way the tool prices it.
   * @param id - The template id.
   * @returns One estimate per generate node, or undefined where it has no price.
   */
  async function estimates(id: string): Promise<Awaited<ReturnType<typeof estimateModelCredits>>[]> {
    const generates = byId(id).nodes.flatMap((node) => (node.role === "generate" ? [node] : []));
    return Promise.all(generates.map((node) => estimateModelCredits(node.model, { params: node.params })));
  }

  for (const [id, count] of [["carried-object-transition", 3], ["vertical-15s-quick-tip", 1]] as const) {
    it(`gives the sum of every generate node's estimate as the exact cost of ${id}`, async () => {
      const each = await estimates(id);
      expect(each).toHaveLength(count);
      for (const one of each) expect(one?.bound, id).toBe("exact");
      const sum = each.reduce((total, one) => total + (one?.credits ?? 0), 0);
      expect(sum).toBeGreaterThan(0);
      expect(await read(id)).toContain(`One apply of this template costs ${formatCredits(sum, "en-US")} credits at its settings.`);
    });
  }
});

describe("a template whose input goes into a slot or whose node stands beside the anchor (inner#1825 design 4.1, 4.2)", () => {
  beforeEach(() => {
    loadFixtureLocales();
    setLocale("en");
  });

  it("names the slot an input goes into", () => {
    expect(describeTemplate(SLOTTED)).toContain('"song" (audio) into "cover" by "audio"');
  });

  it("says a node beside the anchor is not wired and its tag carries the anchor's index", () => {
    const said = describeTemplate(STANDALONE);
    const outro = said.split("; ").find((line) => line.includes('"outro"')) ?? "";
    expect(outro).toMatch(/not wired|no edge/i);
    expect(outro).toContain("anchor");
  });

  it("says how to send a slot input holding material and a node beside the anchor", async () => {
    const said = await read("storyboard-grid-25");
    expect(said).toMatch(/material[^.]*\bfills\b/);
    expect(said).toContain("{ id, key, anchor }");
  });
});

describe("the craft each template gets by what it generates (inner#1825 design 10)", () => {
  it("gives an audio-only template the audio craft and not the picture or video craft", () => {
    loadFixtureLocales();
    const craft = templateCraft(SLOTTED);
    expect(TEMPLATE_CRAFT).toHaveProperty("audio");
    expect(craft).toContain(TEMPLATE_CRAFT.audio);
    expect(craft).not.toContain(TEMPLATE_CRAFT.picture);
    expect(craft).not.toContain(TEMPLATE_CRAFT.video);
  });

  it("writes music, voice and sound effects in the audio craft", () => {
    expect(TEMPLATE_CRAFT).toHaveProperty("audio");
    for (const word of ["BPM", "instrument", "pause", "breath"]) expect(TEMPLATE_CRAFT.audio, word).toContain(word);
  });

  it("fits every sound template: music leaves what a reference gives, and a bed holds several sounds (round 2)", () => {
    expect(TEMPLATE_CRAFT.audio).toMatch(/except what the template takes from a reference picture, video or song/);
    expect(TEMPLATE_CRAFT.audio).toMatch(/each sound in its own phrase/);
    expect(TEMPLATE_CRAFT.audio).toMatch(/a bed may hold several/);
    expect(TEMPLATE_CRAFT.audio).not.toMatch(/one sound per take/);
  });

  it("gives a template generating a video and its sound the picture, video and audio craft", () => {
    const craft = templateCraft(byId("clip-ambience-foley"));
    expect(craft).toContain(TEMPLATE_CRAFT.picture);
    expect(craft).toContain(TEMPLATE_CRAFT.video);
    expect(craft).toContain(TEMPLATE_CRAFT.audio);
  });

  it("keeps a template generating no sound to the picture craft it had", () => {
    for (const id of ["storyboard-grid-25", "single-view-refs-scene"]) {
      const craft = templateCraft(byId(id));
      expect(craft, id).toContain(TEMPLATE_CRAFT.picture);
      expect(craft, id).not.toContain(TEMPLATE_CRAFT.audio);
    }
  });
});
