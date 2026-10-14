// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { miniToolRequestMemberSchema, type MiniToolSpec } from "@shared/mini-tools/index.js";

const SOURCE = { url: "https://example.com/a.png" };
const PROJECT = "00000000-0000-4000-8000-000000000001";
const SPACE = "00000000-0000-4000-8000-000000000002";
const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`);

const base = {
  source: "video",
  labelKey: "x",
  guide: "x",
  icon: "Scissors",
  slots: [],
  sourceParam: "video",
  sourceMany: false,
  run: { kind: "container", op: "cut" },
} as const;

const split: MiniToolSpec = {
  ...base,
  id: "video.split",
  params: [{ kind: "list", key: "cuts", item: { min: 0, max: 600, step: 0.1 }, maxItems: 4 }],
  output: { modality: "video", namePrefix: "PART" },
  outputCount: { kind: "listLength", param: "cuts", plus: 1 },
};

const grid: MiniToolSpec = {
  ...base,
  id: "video.grid",
  params: [
    { kind: "number", key: "rows", default: 2, min: 1, max: 8, step: 1 },
    { kind: "number", key: "cols", default: 2, min: 1, max: 8, step: 1 },
  ],
  output: { modality: "video", namePrefix: "TILE" },
  outputCount: { kind: "product", params: ["rows", "cols"] },
};

const body = (spec: MiniToolSpec, params: Record<string, unknown>, n: number): unknown => ({
  tool: spec.id,
  project_id: PROJECT,
  space_id: SPACE,
  node_ids: ids(n),
  source: SOURCE,
  params,
  slots: {},
});

const picking: MiniToolSpec = {
  ...grid,
  id: "video.picking",
  params: [...grid.params, { kind: "cells", key: "skip" }],
  outputCount: { kind: "product", params: ["rows", "cols"], except: "skip" },
};

describe("miniToolRequestMemberSchema", () => {
  it("takes one node id per picked cell", () => {
    const schema = miniToolRequestMemberSchema(picking);
    expect(schema.safeParse(body(picking, { rows: 2, cols: 2, skip: [1] }, 3)).success).toBe(true);
    expect(schema.safeParse(body(picking, { rows: 2, cols: 2, skip: [1] }, 4)).success).toBe(false);
  });

  it("refuses skipped cells that are not whole non-negative numbers", () => {
    const schema = miniToolRequestMemberSchema(picking);
    expect(schema.safeParse(body(picking, { rows: 2, cols: 2, skip: [1.5] }, 4)).success).toBe(false);
    expect(schema.safeParse(body(picking, { rows: 2, cols: 2, skip: [-1] }, 4)).success).toBe(false);
  });

  it("takes as many node ids as the cut points make segments", () => {
    const schema = miniToolRequestMemberSchema(split);
    expect(schema.safeParse(body(split, { cuts: [5, 12] }, 3)).success).toBe(true);
    expect(schema.safeParse(body(split, { cuts: [5, 12] }, 2)).success).toBe(false);
  });

  it("takes rows times cols node ids", () => {
    const schema = miniToolRequestMemberSchema(grid);
    expect(schema.safeParse(body(grid, { rows: 2, cols: 3 }, 6)).success).toBe(true);
    expect(schema.safeParse(body(grid, { rows: 2, cols: 3 }, 4)).success).toBe(false);
  });

  it("refuses a list longer than its cap or with an item out of range", () => {
    const schema = miniToolRequestMemberSchema(split);
    expect(schema.safeParse(body(split, { cuts: [1, 2, 3, 4, 5] }, 6)).success).toBe(false);
    expect(schema.safeParse(body(split, { cuts: [700] }, 2)).success).toBe(false);
  });
});
