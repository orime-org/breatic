// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one row view every route that answers web-animation executions uses (#1490 design §4.4): the request text, the
 * base a modification started from, the source an export renders, and the export a result already has in the
 * Motion Space the user is in. It carries every field of the execution row as well, because an older tab reads the
 * accepted row's `inputHash` into its landing receipt.
 */

import { describe, expect, it } from "vitest";

import { WebAnimationRowViewSchema } from "../web-animation.js";

const FPS = { num: 24, den: 1 };
const id = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;

const common = {
  id: id(1),
  projectId: id(2),
  spaceId: id(3),
  actorUserId: id(4),
  actionId: "00000000-0000-4000-8000-0000000000a1",
  inputHash: "sha256:abc",
  attempt: 1,
  fence: null,
  billedCredits: "0.30",
  billedAt: "2026-11-15T08:06:00.000000Z",
  origin: "web_animation_space" as const,
  status: "succeeded" as const,
  phase: null,
  steps: [],
  failureReason: null,
  ownProject: true,
  usageCredits: 0.3,
  deadlineAt: "2026-11-15T10:00:00.000000Z",
  createdAt: "2026-11-15T08:00:00.000000Z",
  updatedAt: "2026-11-15T08:05:00.000000Z",
};

const createRow = {
  ...common,
  kind: "web_animation_create" as const,
  engine: "deepseek" as const,
  input: { prompt: "A logo", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS },
  request: "A logo",
  resultSourceVersionId: id(5),
  resultAssetId: null,
  export: null,
};

const modifyRow = {
  ...common,
  id: id(6),
  kind: "web_animation_modify" as const,
  engine: "deepseek" as const,
  input: { baseSourceVersionId: id(5), instruction: "Slower", engine: "deepseek", aspect: "9:16", durationSeconds: 6, fps: FPS },
  request: "Slower",
  base: { executionId: id(1), request: "A logo" },
  resultSourceVersionId: id(7),
  resultAssetId: null,
  export: { executionId: id(8), status: "running" as const },
};

const exportRow = {
  ...common,
  id: id(8),
  kind: "web_animation_export" as const,
  engine: null,
  input: { sourceVersionId: id(7), width: 1080, height: 1920, fps: FPS, durationFrames: 144 },
  source: { executionId: id(6), request: "Slower", base: { executionId: id(1), request: "A logo" } },
  resultSourceVersionId: null,
  resultAssetId: id(9),
};

describe("WebAnimationRowViewSchema", () => {
  it("accepts a create row with its request and no export yet", () => {
    expect(WebAnimationRowViewSchema.parse(createRow)).toEqual(createRow);
  });

  it("accepts a create row from a route without a Space, which carries no export field", () => {
    const { export: _omitted, ...withoutExport } = createRow;
    expect(WebAnimationRowViewSchema.parse(withoutExport)).toEqual(withoutExport);
  });

  it("accepts a modify row with its base and the export it already has", () => {
    expect(WebAnimationRowViewSchema.parse(modifyRow)).toEqual(modifyRow);
  });

  it("accepts an export row whose source is a modification", () => {
    expect(WebAnimationRowViewSchema.parse(exportRow)).toEqual(exportRow);
  });

  it("accepts an export row whose source is a create, without a base", () => {
    const row = { ...exportRow, source: { executionId: id(1), request: "A logo" } };
    expect(WebAnimationRowViewSchema.parse(row)).toEqual(row);
  });

  it("refuses a modify row without its base", () => {
    const { base: _omitted, ...withoutBase } = modifyRow;
    expect(WebAnimationRowViewSchema.safeParse(withoutBase).success).toBe(false);
  });

  it("refuses an export row without its source", () => {
    const { source: _omitted, ...withoutSource } = exportRow;
    expect(WebAnimationRowViewSchema.safeParse(withoutSource).success).toBe(false);
  });

  it("refuses an export field on an export row", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...exportRow, export: null }).success).toBe(false);
  });

  it("refuses a base on a create row", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...createRow, base: { executionId: id(1), request: "A" } }).success).toBe(false);
  });

  it("refuses an engine on an export row", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...exportRow, engine: "deepseek" }).success).toBe(false);
  });

  it("refuses a row without the input hash an older tab reads", () => {
    const { inputHash: _omitted, ...withoutHash } = createRow;
    expect(WebAnimationRowViewSchema.safeParse(withoutHash).success).toBe(false);
  });

  it("refuses an input that belongs to another kind", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...createRow, input: exportRow.input }).success).toBe(false);
  });
});
