// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The mini-tool registry lives in `@breatic/shared`, which cannot read the
 * model yaml; this file checks each model tool against the catalog the
 * worker loads.
 */

import { MINI_TOOLS, PLANNED_VIDEO_TOOL_IDS, isModelTool, modelOf, toolFilledParams, toolParamKeys } from "@breatic/shared/mini-tools";
import {
  DEFAULT_LIGHT_ANGLE,
  LIGHT_ANGLE_GRID,
  LIGHT_COLORS,
  LIGHT_INTENSITIES,
  LIGHT_QUALITIES,
} from "@breatic/shared";
import { getMiniToolsConfig, initCore } from "@breatic/core";
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

const modelTools = MINI_TOOLS.filter((tool) => tool.run.kind === "model");
const plannedContainerClasses = {
  "video.extract-frames": "MiniToolContainerStd4",
  "video.split": "MiniToolContainerStd4",
  // A video focus crop takes one grid frame on standard-4 (frames-split §5.5 configuration row).
  "video.focus-crop": "MiniToolContainerStd4",
} as const;

describe("model tools against the catalog", () => {
  it("binds every planned container execution to its declared registry and Std4 class", () => {
    const config = getMiniToolsConfig();
    const executions = Object.entries(config.executions);
    expect(executions.map(([operation]) => operation).sort()).toEqual(Object.keys(plannedContainerClasses).sort());
    for (const [operation, execution] of executions) {
      // A focus crop is a planned request with no panel tool of its own (frames-split §5.5 plan shape row).
      if (operation === "video.focus-crop") expect(PLANNED_VIDEO_TOOL_IDS).toContain(operation);
      else expect(MINI_TOOLS.find((tool) => tool.id === operation)?.run.kind).toBe("planned");
      // A focus crop's plan has exactly one output (the shared planned-request schema's single-output tools), so its config
      // carries only its class and precheck, the values of frame extraction (frames-split §5.5 configuration row).
      expect(execution).toMatchObject({ container_class: plannedContainerClasses[operation as keyof typeof plannedContainerClasses],
        precheck_seconds: expect.any(Number), ...(operation === "video.focus-crop" ? {} : { max_outputs: expect.any(Number) }) });
    }
    expect(config.executions["video.focus-crop"]).toEqual({ container_class: config.executions["video.extract-frames"].container_class,
      precheck_seconds: config.executions["video.extract-frames"].precheck_seconds });
    expect(config.classes.MiniToolContainerStd4).toMatchObject({ vcpu: 4, memory_gib: 12 });
  });
  it.each(modelTools.map((tool) => [tool.id, tool] as const))(
    "%s names a served model whose params it declares",
    (_id, tool) => {
      const model = catalog().get(modelOf(tool)!);
      expect(model).toBeDefined();
      const params = model!.params ?? {};
      for (const key of toolFilledParams(tool)) expect(Object.keys(params)).toContain(key);
      expect(params[tool.sourceParam]?.type === "list").toBe(tool.sourceMany);
      if (tool.drawing?.kind === "mask") expect(params[tool.drawing.maskParam]?.accepts).toBe("image");
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

  // inner#1304: what a tool declares about a catalog param must hold in the catalog.
  it.each(modelTools.map((tool) => [tool.id, tool] as const))(
    "%s declares defaults, layouts and server-filled params the catalog holds",
    (_id, tool) => {
      const params = catalog().get(modelOf(tool)!)!.params ?? {};
      if (!isModelTool(tool)) return;
      for (const param of tool.params) {
        if (param.default === undefined) continue;
        expect(params[param.key]?.values, `${tool.id}.${param.key}`).toContain(param.default);
      }
      if (tool.sourceAspectParam !== undefined) {
        const spec = params[tool.sourceAspectParam];
        expect(spec?.fill).toBe("none");
        expect(spec?.values).toContain("auto");
        expect(spec?.absent_value).toBe("auto");
      }
    },
  );

  it("draws the light sphere on exactly the light grid, from its reset pose", () => {
    const relight = MINI_TOOLS.find((tool) => tool.id === "image.relight")!;
    const params = catalog().get(modelOf(relight)!)!.params ?? {};
    const sphere = isModelTool(relight) ? relight.params.filter((p) => p.display === "lightAngle").map((p) => p.key) : [];
    expect(sphere).toEqual(["light_azimuth", "light_elevation"]);
    const walk = (key: string): number[] => {
      const spec = params[key]!;
      const steps: number[] = [];
      for (let v = Number(spec.min); v <= Number(spec.max); v += Number(spec.step)) steps.push(v);
      return steps;
    };
    expect(walk("light_azimuth")).toEqual([...LIGHT_ANGLE_GRID.azimuth]);
    expect(walk("light_elevation")).toEqual([...LIGHT_ANGLE_GRID.elevation]);
    expect(params.light_azimuth?.default).toBe(DEFAULT_LIGHT_ANGLE.azimuth);
    expect(params.light_elevation?.default).toBe(DEFAULT_LIGHT_ANGLE.elevation);
    for (const key of ["light_azimuth", "light_elevation"]) {
      expect(Object.keys(params[key]?.value_labels ?? {}).map(Number).sort((a, b) => a - b), key).toEqual(walk(key));
    }
  });

  it("has a phrase for every light colour, intensity and quality the catalog offers", () => {
    const params = catalog().get("nano-banana-2-relight")!.params ?? {};
    const offered = (key: string): unknown[] => (params[key]?.values ?? []).filter((v) => v !== "auto");
    expect(offered("light_color")).toEqual([...Object.keys(LIGHT_COLORS), "custom"]);
    expect(params.light_color_hex).toMatchObject({ type: "text", fill: "tool" });
    expect(offered("light_intensity")).toEqual(Object.keys(LIGHT_INTENSITIES));
    expect(offered("light_quality")).toEqual(Object.keys(LIGHT_QUALITIES));
  });
  it("leaves no fill: tool param unclaimed", () => {
    const claimed = new Set<string>();
    for (const tool of modelTools) {
      const name = modelOf(tool)!;
      for (const key of [...toolFilledParams(tool), ...toolParamKeys(tool)]) {
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
