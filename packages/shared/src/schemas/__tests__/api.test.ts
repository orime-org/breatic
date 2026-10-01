// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import {
  chatAttachedChipSchema,
  chatMessageSchema,
  projectCreateSchema,
  taskCreateSchema,
} from "@shared/schemas/api.js";

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

describe("chatAttachedChipSchema — id", () => {
  const chip = { type: "image", name: "cover.png", data_snapshot: { url: "https://cdn.example/c.png" } };

  it("refuses an id longer than any node or file id", () => {
    expect(chatAttachedChipSchema.safeParse({ ...chip, id: "x".repeat(129) }).success).toBe(false);
  });

  it("takes an id as long as a uuid", () => {
    expect(chatAttachedChipSchema.safeParse({ ...chip, id: "0".repeat(36) }).success).toBe(true);
  });
});

describe("chatMessageSchema — time_zone", () => {
  const message = {
    message: "what time is it?",
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };

  it("takes the zone the browser reports", () => {
    const parsed = chatMessageSchema.parse({ ...message, time_zone: "Asia/Shanghai" });
    expect(parsed.time_zone).toBe("Asia/Shanghai");
  });

  it("takes a message without one", () => {
    expect(chatMessageSchema.parse(message).time_zone).toBeUndefined();
  });

  it("refuses an empty zone and one longer than 64 characters", () => {
    expect(chatMessageSchema.safeParse({ ...message, time_zone: "" }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...message, time_zone: "x".repeat(65) }).success).toBe(false);
  });
});
