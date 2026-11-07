// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `list_generation_models` with a target (inner#1691 design 6.1): the canvas
 * answer stays as it is, and `target: '3d'` reads the 3D catalog, listing
 * both Tripo H3.1 image-to-3D variants. The input stays one object, because
 * the OpenAI-compatible endpoint the agent calls takes only an object root.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asSchema } from "ai";

import { generationModels, type PricedModelsForMode } from "@domain/agent/tools/generation-models.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/** The tool's input schema, read the way the SDK reads it. */
const inputSchema = (generationModels as unknown as {
  inputSchema: { safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown } };
}).inputSchema;

/**
 * Run the tool the way a turn does: the input passes its schema first.
 * @param input - What the model sent.
 * @returns The tool's answer.
 * @throws {Error} When the schema refuses the input, or the tool throws.
 */
async function run(input: unknown): Promise<PricedModelsForMode> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`the input schema refused ${JSON.stringify(input)}: ${String(parsed.error)}`);
  const execute = (generationModels as unknown as {
    execute: (i: unknown, o: object) => Promise<PricedModelsForMode>;
  }).execute;
  return execute(parsed.data, {});
}

describe("list_generation_models input", () => {
  it("serializes its parameters with an object root", () => {
    const schema = asSchema(generationModels.inputSchema).jsonSchema as { type?: unknown };
    expect(schema.type).toBe("object");
  });

  it("answers a canvas question the same with target left out or set to canvas", async () => {
    const without = await run({ nodeType: "image", mode: "t2i" });
    const withTarget = await run({ target: "canvas", nodeType: "image", mode: "t2i" });
    expect(withTarget).toEqual(without);
  });
});

describe("list_generation_models with target 3d", () => {
  it("lists the one text-to-3D entry for t23d", async () => {
    const answer = await run({ target: "3d", mode: "t23d" });
    if (!answer.available) throw new Error(`expected models, got ${JSON.stringify(answer)}`);
    expect(answer.models.map((model) => [model.name, model.displayName])).toEqual([
      ["tripo-h3.1-t23d", "Tripo H3.1"],
    ]);
  });

  it("lists the Single image and Multi-view variants for i23d", async () => {
    const answer = await run({ target: "3d", mode: "i23d" });
    if (!answer.available) throw new Error(`expected models, got ${JSON.stringify(answer)}`);
    expect(answer.models.map((model) => [model.name, model.displayName])).toEqual([
      ["tripo-h3.1-i23d", "Tripo H3.1 Single image"],
      ["tripo-h3.1-multiview", "Tripo H3.1 Multi-view"],
    ]);
  });

  it("throws an error naming the rule when a 3d question carries a nodeType", async () => {
    // The schema keeps one object root, so the combination is judged in execute.
    expect(inputSchema.safeParse({ target: "3d", nodeType: "image", mode: "t23d" }).success).toBe(true);
    const execute = (generationModels as unknown as {
      execute: (i: unknown, o: object) => Promise<PricedModelsForMode>;
    }).execute;
    const outcome = execute({ target: "3d", nodeType: "image", mode: "t23d" }, {});
    await expect(outcome).rejects.toThrow(/nodeType/);
    await expect(execute({ target: "3d", nodeType: "image", mode: "t23d" }, {})).rejects.toThrow(/3d/);
  });
});
