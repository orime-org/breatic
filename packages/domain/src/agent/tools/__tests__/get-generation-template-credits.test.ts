// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The cost sentences of `get_generation_template` when some or all of a
 * template's generate nodes are not exactly priced (inner#1816), and when a
 * take of it is or is not cheaper than its final (inner#1811). The model
 * catalog's estimate is replaced by tables keyed by node model, so the other
 * test file keeps the real catalog.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocales } from "@breatic/core";
import { formatCredits, setLocale } from "@breatic/shared";
import type { CreditEstimate } from "@breatic/shared/pricing";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import type * as Catalog from "@domain/model-catalog/model-catalog.js";

import { TOOL_MAP } from "../index.js";

/** What each model is priced at in the current test, whatever its settings; a model left out has no price. */
const PRICES = vi.hoisted(() => new Map<string, CreditEstimate>());

/** Models whose price in the current test depends on their settings; these win over PRICES. */
const PRICED_BY_SETTINGS = vi.hoisted(() => new Map<string, (params: Record<string, unknown>) => CreditEstimate>());

vi.mock("@domain/model-catalog/model-catalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof Catalog>();
  return {
    ...original,
    estimateModelCredits: vi.fn(async (model: string, input: { params: Record<string, unknown> }) => PRICED_BY_SETTINGS.get(model)?.(input.params) ?? PRICES.get(model)),
  };
});

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
  PRICES.clear();
  PRICED_BY_SETTINGS.clear();
});

afterAll(() => {
  loadLocales();
  setLocale("en");
  restoreProcessEnv();
});

/**
 * What the tool answers for one template id.
 * @param id - The template id.
 * @returns The text it returns.
 */
async function read(id: string): Promise<string> {
  const build = TOOL_MAP["get_generation_template"];
  if (build === undefined) throw new Error("get_generation_template is not registered");
  const { execute } = build() as unknown as { execute?: (input: unknown, options: object) => Promise<unknown> };
  if (execute === undefined) throw new Error("no execute");
  return String(await execute({ id }, {}));
}

// carried-object-transition: "result" on seedance-2.5-image-to-video, "scene-a" and "scene-b" on nano-banana-pro-edit-ultra.
const VIDEO = "seedance-2.5-image-to-video";
const SCENE = "nano-banana-pro-edit-ultra";

describe("the cost of one apply when not every node is exactly priced", () => {
  it("says at least the sum of the priced nodes when one node has no price", async () => {
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    expect(await read("carried-object-transition")).toContain(`At its settings this template costs at least ${formatCredits(25, "en-US")} credits.`);
  });

  it("says at least the sum when one node's estimate is not exact", async () => {
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    PRICES.set(VIDEO, { credits: 1200.25, bound: "at_least" });
    expect(await read("carried-object-transition")).toContain(`At its settings this template costs at least ${formatCredits(1225.25, "en-US")} credits.`);
  });

  it("gives the exact sum, written by formatCredits, when every node is exactly priced", async () => {
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    PRICES.set(VIDEO, { credits: 1200.25, bound: "exact" });
    const answer = await read("carried-object-transition");
    expect(answer).toContain(`At its settings this template costs ${formatCredits(1225.25, "en-US")} credits.`);
    // Priced the same at every setting, so a take would cost what the final does: no take is offered.
    expect(answer).not.toContain("A take costs");
  });

  it("says nothing of cost when no node has a price", async () => {
    expect(await read("carried-object-transition")).not.toContain("this template costs");
  });
});

describe("the take of a template", () => {
  it("is offered with the cheaper settings, priced exactly or as a floor on its own, when they cost less", async () => {
    // Exact at the template's settings, a floor once silent: the two sentences must each keep their own bound.
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    PRICED_BY_SETTINGS.set(VIDEO, (params) => (params.generate_audio === false ? { credits: 1000, bound: "at_least" } : { credits: 1200.25, bound: "exact" }));
    const answer = await read("carried-object-transition");
    expect(answer).toContain(`At its settings this template costs ${formatCredits(1225.25, "en-US")} credits.`);
    expect(answer).toContain('write these cheaper settings in its generate nodes\' params: {"result":{"generate_audio":false}}.');
    expect(answer).toContain(`A take costs at least ${formatCredits(1025, "en-US")} credits;`);
  });

  it("is not offered when a setting cheaper on its own costs no less beside the template's other settings", async () => {
    // product-ad-15s: "result" on seedance-2.5-text-to-video runs 15 seconds with sound, the model's default length being shorter.
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    PRICED_BY_SETTINGS.set("seedance-2.5-text-to-video", (params) => ({
      credits: params.generate_audio === false && (params.duration ?? 5) !== 15 ? 100 : 1200.25,
      bound: "exact",
    }));
    const answer = await read("product-ad-15s");
    expect(answer).toContain(`At its settings this template costs ${formatCredits(1212.75, "en-US")} credits.`);
    expect(answer).not.toContain("A take costs");
  });
});
