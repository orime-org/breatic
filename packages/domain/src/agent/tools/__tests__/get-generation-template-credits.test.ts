// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The cost sentence of `get_generation_template` when some or all of a
 * template's generate nodes are not exactly priced (inner#1816). The model
 * catalog's estimate is replaced by a table keyed by node model, so the
 * other test file keeps the real catalog.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocales } from "@breatic/core";
import { formatCredits, setLocale } from "@breatic/shared";
import type { CreditEstimate } from "@breatic/shared/pricing";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import type * as Catalog from "@domain/model-catalog/model-catalog.js";

import { TOOL_MAP } from "../index.js";

/** What each model is priced at in the current test; a model left out has no price. */
const PRICES = vi.hoisted(() => new Map<string, CreditEstimate>());

vi.mock("@domain/model-catalog/model-catalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof Catalog>();
  return { ...original, estimateModelCredits: vi.fn(async (model: string) => PRICES.get(model)) };
});

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
  PRICES.clear();
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
    expect(await read("carried-object-transition")).toContain(`One apply of this template costs at least ${formatCredits(25, "en-US")} credits at its settings.`);
  });

  it("says at least the sum when one node's estimate is not exact", async () => {
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    PRICES.set(VIDEO, { credits: 1200.25, bound: "at_least" });
    expect(await read("carried-object-transition")).toContain(`One apply of this template costs at least ${formatCredits(1225.25, "en-US")} credits at its settings.`);
  });

  it("gives the exact sum, written by formatCredits, when every node is exactly priced", async () => {
    PRICES.set(SCENE, { credits: 12.5, bound: "exact" });
    PRICES.set(VIDEO, { credits: 1200.25, bound: "exact" });
    expect(await read("carried-object-transition")).toContain(`One apply of this template costs ${formatCredits(1225.25, "en-US")} credits at its settings.`);
  });

  it("says nothing of cost when no node has a price", async () => {
    expect(await read("carried-object-transition")).not.toContain("One apply of this template costs");
  });
});
