// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one row view every route that answers web-animation executions uses (#1490 design §4.4): the request text, the
 * base a modification started from, the source an export renders, and the export a result already has in the
 * Motion Space the user is in, beside the execution fields the Motion and Timeline lists read.
 */

import { describe, expect, it } from "vitest";

import { WebAnimationRowViewSchema } from "../web-animation.js";

const FPS = { num: 24, den: 1 };
const id = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;

const common = {
  id: id(1),
  spaceId: id(3),
  status: "succeeded" as const,
  phase: null,
  failureReason: null,
  ownProject: true,
  actorUserId: "60000000-0000-4000-8000-000000000009",
  slotWaitSince: null,
  slotWaitLimit: null,
  usageCredits: 0.3,
  createdAt: "2026-11-15T08:00:00.000000Z",
};

const createRow = {
  ...common,
  kind: "web_animation_create" as const,
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
  input: { sourceVersionId: id(7), width: 1080, height: 1920, fps: FPS, durationFrames: 144, videoKey: "generated/2026/11/15/v.mp4" },
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

  it.each(["projectId", "actorUserId", "actionId", "inputHash", "attempt", "fence", "billedCredits", "billedAt", "origin", "steps", "deadlineAt", "updatedAt", "engine"])(
    "refuses an execution field no list reads: %s",
    (field) => {
      expect(WebAnimationRowViewSchema.safeParse({ ...createRow, [field]: null }).success).toBe(false);
    },
  );

  it("refuses an input that belongs to another kind", () => {
    expect(WebAnimationRowViewSchema.safeParse({ ...createRow, input: exportRow.input }).success).toBe(false);
  });
});
