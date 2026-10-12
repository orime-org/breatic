// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { gridShapeOf, outputTemplateOf, outputsOf, type MiniToolSpec } from "@shared/mini-tools/index.js";

const TILE = { modality: "image", namePrefix: "GRID" } as const;

const base = {
  source: "image",
  labelKey: "x",
  guide: "x",
  icon: "Crop",
  slots: [],
  sourceParam: "image",
  sourceMany: false,
} as const;

const fixed: MiniToolSpec = {
  ...base,
  id: "image.fixed",
  run: { kind: "browser" },
  params: [],
  outputs: [
    { modality: "audio", namePrefix: "VOCALS" },
    { modality: "audio", namePrefix: "BACKING" },
  ],
};

const product: MiniToolSpec = {
  ...base,
  id: "image.product",
  run: { kind: "browser" },
  params: [
    { kind: "number", key: "rows", default: 3, min: 1, max: 8, step: 1 },
    { kind: "number", key: "cols", default: 3, min: 1, max: 8, step: 1 },
  ],
  output: TILE,
  outputCount: { kind: "product", params: ["rows", "cols"] },
};

const listed: MiniToolSpec = {
  ...base,
  id: "video.split",
  source: "video",
  run: { kind: "container", op: "cut" },
  params: [{ kind: "list", key: "cuts", item: { min: 0, max: 3600, step: 0.1 }, maxItems: 20 }],
  output: { modality: "video", namePrefix: "PART" },
  outputCount: { kind: "listLength", param: "cuts", plus: 1 },
};

describe("outputsOf", () => {
  it("returns a fixed tool's outputs as declared", () => {
    expect(outputsOf(fixed, {})).toEqual(fixed.outputs);
  });

  it("repeats the template rows times cols for a product count", () => {
    const outputs = outputsOf(product, { rows: 2, cols: 4 });
    expect(outputs).toHaveLength(8);
    expect(outputs.every((output) => output === TILE)).toBe(true);
  });

  it("falls back to each param's default when the params leave it out", () => {
    expect(outputsOf(product, {})).toHaveLength(9);
  });

  it("counts a list's items plus the declared extra", () => {
    expect(outputsOf(listed, { cuts: [10, 20.5, 31] })).toHaveLength(4);
    expect(outputsOf(listed, { cuts: [] })).toHaveLength(1);
  });
});

describe("gridShapeOf", () => {
  const grid: MiniToolSpec = { ...product, outputLayout: "grid" } as MiniToolSpec;

  it("reads a grid tool's rows and columns from the params it counts by", () => {
    expect(gridShapeOf(grid, { rows: 2, cols: 4 })).toEqual({ rows: 2, cols: 4 });
  });

  it("falls back to each param's default", () => {
    expect(gridShapeOf(grid, {})).toEqual({ rows: 3, cols: 3 });
  });

  it("has no shape for a tool that does not lay its results out as a grid", () => {
    expect(gridShapeOf(product, {})).toBeNull();
    expect(gridShapeOf(fixed, {})).toBeNull();
  });
});

describe("outputTemplateOf", () => {
  it("gives a fixed tool's first output", () => {
    expect(outputTemplateOf(fixed)).toEqual({ modality: "audio", namePrefix: "VOCALS" });
  });

  it("gives a variable tool's single template", () => {
    expect(outputTemplateOf(product)).toBe(TILE);
  });
});
