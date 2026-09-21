// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { projectCreateSchema, taskCreateSchema } from "@shared/schemas/api.js";

const base = {
  studioId: "11111111-1111-4111-8111-111111111111",
  name: "My Project",
  slug: "my-project",
};

describe("projectCreateSchema — spaceType (B.2 create→seed plumbing)", () => {
  it("defaults spaceType to canvas when omitted", () => {
    expect(projectCreateSchema.parse(base).spaceType).toBe("canvas");
  });

  it("accepts the three known space types", () => {
    for (const type of ["canvas", "document", "timeline"] as const) {
      expect(projectCreateSchema.parse({ ...base, spaceType: type }).spaceType).toBe(
        type,
      );
    }
  });

  it("rejects an unknown space type", () => {
    expect(() => projectCreateSchema.parse({ ...base, spaceType: "3d" })).toThrow();
  });
});

describe("projectCreateSchema — visibility", () => {
  it("defaults visibility to studio when omitted", () => {
    // Load-bearing since 2026-08-07. The create dialog dropped the visibility
    // picker and the client stopped sending the field, so this default is now
    // the only thing deciding what every new project gets: flipping it to
    // 'private' would hide every project created from then on from most of its
    // studio. The route's own assertion (server routes/projects.test.ts) reads
    // the same default through zValidator, so that flip turns both red —
    // verified. The segment past the route is watched separately, by an
    // assertion on the created row in the project-visibility-materialize
    // integration suite; that one calls the service with an explicit value, so
    // it guards against the repo rewriting it rather than against this flip.
    expect(projectCreateSchema.parse(base).visibility).toBe("studio");
  });

  it("still accepts an explicit value", () => {
    // The request schema deliberately kept the field, so a caller that sends
    // one is honoured. That is the accepted gap of stopping at the UI layer,
    // not an oversight — pinning it here so removing it reads as a decision.
    expect(projectCreateSchema.parse({ ...base, visibility: "private" }).visibility).toBe(
      "private",
    );
  });
});

describe("taskCreateSchema — source", () => {
  const task = {
    task_type: "image",
    params: {},
    project_id: "11111111-1111-4111-8111-111111111111",
    space_id: "22222222-2222-4222-8222-222222222222",
    mode: "append" as const,
  };

  // The column has one vocabulary, and a caller that names no lane falls to
  // this default rather than to the column's own — which is a word from
  // before that vocabulary existed, and would reach the feed as a row
  // nothing can render.
  it("files a caller that names no lane under the generic one", () => {
    expect(taskCreateSchema.parse(task).source).toBe("task");
  });

  it("keeps the lane a caller does name", () => {
    expect(taskCreateSchema.parse({ ...task, source: "understand" }).source).toBe(
      "understand",
    );
  });

  it("refuses a lane outside the vocabulary", () => {
    expect(() => taskCreateSchema.parse({ ...task, source: "canvas" })).toThrow();
  });
});
