// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Agent's catalog tools on the Studio payer's own keys (inner#1953): a model the payer runs on their own key is
 * offered as runnable even where the deployment holds no key for it, and is never quoted a credit price, since a run of
 * it costs no credits; describing its inputs on our language model is said to take credits.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocales } from "@breatic/core";
import { setLocale } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import type * as Catalog from "@domain/model-catalog/model-catalog.js";
import type * as Keys from "@domain/provider/provider-keys.js";

import { TOOL_MAP } from "../index.js";
import { renderGenerationModelsForModel, type PricedModelsForMode } from "../generation-models.js";

const h = vi.hoisted(() => ({ mediaOnPayer: new Set<string>(), describes: new Set<string>(), llmOnPayer: false }));
const ACCOUNT_KEYS = { owner: "account", keyOf: () => "acct" } as const;

vi.mock("@domain/model-catalog/model-catalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof Catalog>();
  return { ...original, estimateModelCredits: vi.fn(async () => ({ credits: 5, bound: "exact" })) };
});
vi.mock("@domain/provider/provider-keys.js", async (importOriginal) => {
  const original = await importOriginal<typeof Keys>();
  return {
    ...original,
    runDescribesInput: (model: string) => h.describes.has(model),
    resolveKeys: vi.fn(async (_payer: unknown, purpose: { kind: string; model?: string }) => {
      const onPayer = purpose.kind === "llm" ? h.llmOnPayer : h.mediaOnPayer.has(purpose.model ?? "");
      return onPayer
        ? { keys: ACCOUNT_KEYS, route: { mode: "default" }, keyId: "key-row", payerUserId: "admin-1" }
        : { keys: { owner: "deployment", keyOf: () => undefined }, route: { mode: "default" }, keyId: null, payerUserId: null };
    }),
  };
});

const CONTEXT = { context: { studioId: "studio-1" } };

/**
 * The tool built for a turn, called the way the SDK calls it.
 * @param name - The tool's name.
 * @returns Its execute.
 */
function executeOf(name: string): (input: unknown, options: object) => Promise<unknown> {
  const build = TOOL_MAP[name];
  if (build === undefined) throw new Error(`${name} is not registered`);
  const { execute } = build() as unknown as { execute?: (input: unknown, options: object) => Promise<unknown> };
  if (execute === undefined) throw new Error("no execute");
  return execute;
}

/**
 * The image models of t2i as the tool answers them for the studio.
 * @returns The answer.
 */
async function imageModels(): Promise<PricedModelsForMode> {
  return (await executeOf("list_generation_models")({ nodeType: "image", mode: "t2i" }, CONTEXT)) as PricedModelsForMode;
}

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
  h.mediaOnPayer.clear();
  h.describes.clear();
  h.llmOnPayer = false;
});

afterAll(() => {
  restoreProcessEnv();
});

describe("list_generation_models on the Studio payer's own keys", () => {
  it("offers a model on the payer's key as runnable, at no credits, even where the deployment holds no key for it", async () => {
    const before = await imageModels();
    if (!before.available) throw new Error("t2i has no models");
    const model = before.models[0]!.name;
    h.mediaOnPayer.add(model);

    const answer = await imageModels();
    if (!answer.available) throw new Error("t2i has no models");
    const line = renderGenerationModelsForModel({ available: true, models: answer.models.filter((m) => m.name === model) });
    expect(line).toContain("no credits; it runs on the Studio payer's own key");
    expect(line).not.toContain("Not set up on this deployment");
    expect(line).not.toMatch(/\d+(\.\d+)? credits/);
  });

  it("says describing its inputs takes credits when the language model runs on ours", async () => {
    const before = await imageModels();
    if (!before.available) throw new Error("t2i has no models");
    const model = before.models[0]!.name;
    h.mediaOnPayer.add(model);
    h.describes.add(model);

    const answer = await imageModels();
    if (!answer.available) throw new Error("t2i has no models");
    const line = renderGenerationModelsForModel({ available: true, models: answer.models.filter((m) => m.name === model) });
    expect(line).toContain("it runs on the Studio payer's own key, but describing its inputs takes credits");
  });

  it("prices a model on our keys in credits, as before", async () => {
    const answer = await imageModels();
    if (!answer.available) throw new Error("t2i has no models");
    expect(answer.models.every((m) => m.price?.credits === 5)).toBe(true);
  });
});

describe("get_generation_template on the Studio payer's own keys", () => {
  it("leaves a generate node on the payer's key out of the credit sum and says so", async () => {
    const all = String(await executeOf("get_generation_template")({ id: "carried-object-transition" }, CONTEXT));
    expect(all).toMatch(/costs 15 credits/);
    h.mediaOnPayer.add("seedance-2.5-image-to-video");

    const text = String(await executeOf("get_generation_template")({ id: "carried-object-transition" }, CONTEXT));
    expect(text).toMatch(/costs 10 credits/);
    expect(text).toContain("seedance-2.5-image-to-video runs on the Studio payer's own key, at no credits");
  });
});
