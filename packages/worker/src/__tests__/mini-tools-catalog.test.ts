// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mini-tool registry lives in `@breatic/shared`, which cannot read the
 * model yaml; this file checks each model tool against the catalog the
 * worker loads.
 */

import { MINI_TOOLS, modelOf, toolParamKeys } from "@breatic/shared/mini-tools";
import { initCore } from "@breatic/core";
import { getFullModelConfig } from "@breatic/domain";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  initCore({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://localhost:5432/breatic_test",
  });
});

type FullModel = ReturnType<typeof getFullModelConfig>["models"][number];

/**
 * Every model in the catalog, keyed by name.
 * @returns The catalog's models.
 */
function catalog(): Map<string, FullModel> {
  const byName = new Map<string, FullModel>();
  for (const bucket of ["image", "video", "audio"]) {
    for (const model of getFullModelConfig(bucket).models) byName.set(model.name, model);
  }
  return byName;
}

/**
 * The bare identifiers a pricing formula reads, leaving out `$` variables,
 * function calls, a call's named arguments (`get_duration(video, max=30)`),
 * quoted strings and the provider's own pricing constants.
 * @param formula - The JSONata pricing formula.
 * @param constants - The provider pricing keys the formula may read.
 * @returns The param names the formula reads.
 */
function formulaParams(formula: string, constants: ReadonlySet<string>): string[] {
  const unquoted = formula.replace(/\\?"[^"\\]*(?:\\.[^"\\]*)*\\?"/g, " ");
  const bare = unquoted.replace(/([(,]\s*)[a-z_][a-z0-9_]*=(?!=)/g, "$1");
  const names = new Set<string>();
  for (const match of bare.matchAll(/(?<![$\w.])([a-z_][a-z0-9_]*)\b(?!\s*\()/g)) {
    const name = match[1]!;
    if (["true", "false", "null", "and", "or", "in"].includes(name)) continue;
    if (constants.has(name)) continue;
    names.add(name);
  }
  return [...names];
}

const modelTools = MINI_TOOLS.filter((tool) => tool.run.kind === "model");

describe("model tools against the catalog", () => {
  it.each(modelTools.map((tool) => [tool.id, tool] as const))(
    "%s names a served model whose params it declares",
    (_id, tool) => {
      const model = catalog().get(modelOf(tool)!);
      expect(model).toBeDefined();
      const params = model!.params ?? {};
      expect(Object.keys(params)).toContain(tool.sourceParam);
      for (const slot of tool.slots) {
        expect(Object.keys(params)).toContain(slot.param);
        expect(params[slot.param]?.accepts).toBe(slot.accepts);
        if (slot.many) expect(params[slot.param]?.max_items).toBeGreaterThan(0);
      }
      for (const key of toolParamKeys(tool)) {
        expect(["tool", "panel"]).toContain(params[key]?.fill ?? "none");
      }
      expect(tool.prompt !== undefined).toBe(model!.takes_prompt);
    },
  );

  it("reads only declared params in every pinned model's pricing formula", () => {
    const models = catalog();
    const undeclared: string[] = [];
    for (const tool of modelTools) {
      const model = models.get(modelOf(tool)!)!;
      for (const provider of model.providers ?? []) {
        const formula = provider.pricing?.formula ?? "";
        const constants = new Set(Object.keys(provider.pricing ?? {}));
        for (const name of formulaParams(formula, constants)) {
          if (!(name in (model.params ?? {}))) undeclared.push(`${model.name}.${name}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("leaves no fill: tool param unclaimed", () => {
    const claimed = new Set<string>();
    for (const tool of modelTools) {
      const name = modelOf(tool)!;
      for (const key of [tool.sourceParam, ...tool.slots.map((s) => s.param), ...toolParamKeys(tool)]) {
        claimed.add(`${name}.${key}`);
      }
    }
    const unclaimed: string[] = [];
    for (const model of catalog().values()) {
      for (const [key, spec] of Object.entries(model.params ?? {})) {
        if (spec.fill === "tool" && !claimed.has(`${model.name}.${key}`)) {
          unclaimed.push(`${model.name}.${key}`);
        }
      }
    }
    expect(unclaimed).toEqual([]);
  });
});
