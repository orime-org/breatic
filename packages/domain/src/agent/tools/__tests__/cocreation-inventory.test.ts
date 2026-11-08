// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the tools, templates and model guides say, held to the co-creation
 * rules (breatic#1361).
 *
 * How the agent judges -- what to ask, when to make takes, what to suggest --
 * is said once, in the system prompt's working rules; a tool, a template or a
 * model guide says only its own mechanism. Each case below reads the text the
 * model is handed and fails on a sentence that judged on the rules' behalf:
 * handing the creative work to the user, steering takes to a costly model,
 * offering a template unasked, or making a character sheet before anything
 * else. It also holds the places that point at the product guide to name a
 * section the guide has.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES } from "@breatic/shared";

import { getFullModelConfig, MODALITIES } from "@domain/model-catalog/model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { generationModels } from "../generation-models.js";
import { judgeLikelihood } from "../judge-likelihood.js";
import { productGuide, renderProductGuide } from "../product-guide.js";
import { makeProposeCanvasAction } from "../propose-canvas-action.js";
import { TEMPLATE_CRAFT } from "../template-craft.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * A description with its hard wraps folded, so assertions are about wording.
 * @param description - The description as declared.
 * @returns It on one line.
 */
function flat(description: unknown): string {
  return typeof description === "string" ? description.replace(/\s+/g, " ") : "";
}

/** The proposal tool's description, as the model reads it. */
const proposeSaid = (): string => flat(makeProposeCanvasAction().description);

describe("the templates leave the creative work with the agent", () => {
  it("says what a template needs, never that the user writes or lists it", () => {
    const handing = GENERATION_TEMPLATES.flatMap((template) =>
      ["the user writes", "the user lists", "the user only writes"].filter((handed) => template.agentNote.includes(handed)).map((handed) => `${template.id}: "${handed}"`),
    );
    expect(handing).toEqual([]);
  });

  it("offers the character design from words only once the look is settled", () => {
    const template = GENERATION_TEMPLATES.find((one) => one.id === "character-design-from-text");
    if (template === undefined) throw new Error("character-design-from-text is not registered");
    const settled = /\b(?:look|style)\b[^.;]*\bsettled\b|\bsettled\b[^.;]*\b(?:look|style)\b/i;
    expect(template.agentNote).toMatch(settled);
    expect(template.triggers.offerWhen.join("; ")).toMatch(settled);
  });

  it("leaves when to make a character sheet to the working rules, and keeps the craft of keeping the reference's rendering", () => {
    expect(TEMPLATE_CRAFT.character).not.toContain("make a character sheet before the shots");
    expect(TEMPLATE_CRAFT.character).toContain("keep the reference's rendering");
  });
});

describe("propose_canvas_action says its mechanism, not when to propose", () => {
  it("never offers a template unasked", () => {
    expect(proposeSaid()).not.toMatch(/unasked/i);
  });

  it("keeps where the open canvas is found", () => {
    expect(proposeSaid()).toContain("The Space the user has open");
  });

  it("names the shape of takes with no material: several generations, each with its full prompt, in one named group", () => {
    expect(proposeSaid()).toMatch(/with no material, several generations,? each with its (?:own )?full prompt,? in one named group/i);
  });

  it("says clips for a Timeline are made as video on a canvas", () => {
    expect(proposeSaid()).toMatch(/clips? (?:for|used in|in) a timeline[^.]*\bvideo\b[^.]*\bcanvas\b/i);
  });
});

describe("judge_likelihood judges what the material at hand settles", () => {
  const said = (): string => flat(judgeLikelihood.description);

  it("no longer judges by odds how to read the user, which way to make it or whether to ask", () => {
    expect(said()).not.toContain("the user's sentence has several readings and you do not know which to act on");
    expect(said()).not.toContain("you can see several ways to do something and cannot tell which suits this time");
    expect(said()).not.toContain("you cannot tell whether they said enough to start on, or whether to ask them first");
  });

  it("leaves a reading that changes what gets made, and a choice of taste, to the working rules", () => {
    expect(said()).toContain("your working rules");
  });
});

describe("the model guides steer no take to a costly model", () => {
  /**
   * Guides that say default and need no final-only condition: the upscaler is
   * itself a step on a final, and the picture model's default already carries
   * its condition (when the image simply has to be as good as it gets).
   */
  const STANDING: ReadonlySet<string> = new Set(["pro-upscaler", "gpt-image-2.5-sunburst-text-to-image"]);

  it("limits every default a guide claims to a final", () => {
    const unbounded: string[] = [];
    let read = 0;
    for (const modality of MODALITIES) {
      for (const model of getFullModelConfig(modality).models) {
        const guide = (model.guide ?? "").replace(/\s+/g, " ");
        if (!/\bdefault\b/i.test(guide)) continue;
        read += 1;
        if (STANDING.has(model.name)) continue;
        if (!/\bdefault for a final\b/i.test(guide)) unbounded.push(`${modality}/${model.name}: ${guide}`);
      }
    }
    expect(read, "the catalog has guides saying default").toBeGreaterThan(0);
    expect(unbounded).toEqual([]);
  });
});

describe("the tools that point at the product guide name its section", () => {
  /** Every section the guide has, by its heading. */
  const sections = (): string[] => [...renderProductGuide().matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? "");

  for (const [tool, said, name] of [
    ["propose_canvas_action", (): string => proposeSaid(), "Proposal cards"],
    ["list_generation_models", (): string => flat(generationModels.description), "Source slots"],
  ] as const) {
    it(`${tool} names "${name}", a section the guide's index lists`, () => {
      expect(said()).toContain(`"${name}"`);
      expect(sections()).toContain(name);
      expect(flat(productGuide.description)).toContain(name);
    });
  }
});
