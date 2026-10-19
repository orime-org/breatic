// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * GenerationActivityPayloadSchema preview-field contract (#1622).
 *
 * The activity feed's playable hover preview + credits display read these
 * fields off the generation payload. They are all optional (a non-media
 * generation — understand — and every legacy row omit them), `kind` is
 * constrained to the media modalities the preview can render, and
 * `credits` is a float (video models bill fractional credits, e.g. 1.5)
 * mirroring the doublePrecision `tasks.billed_credits` column — so the
 * schema must NOT coerce it to an integer.
 */

import { describe, it, expect } from "vitest";

import {
  GenerationActivityPayloadSchema,
  AssetActivityPayloadSchema,
} from "../project-activity.js";
import { isMemberLeave, type ProjectActivityEntry } from "@shared/index.js";

describe("GenerationActivityPayloadSchema #1622 preview fields", () => {
  it("carries kind / fileUrl / thumbnailUrl / credits when present", () => {
    const p = GenerationActivityPayloadSchema.parse({
      source: "task",
      kind: "video",
      fileUrl: "https://cdn.example/x.mp4",
      thumbnailUrl: "https://cdn.example/x.jpg",
      credits: 1.5,
    });
    expect(p.kind).toBe("video");
    expect(p.fileUrl).toBe("https://cdn.example/x.mp4");
    expect(p.thumbnailUrl).toBe("https://cdn.example/x.jpg");
    // float preserved — not rounded, not rejected (mirrors doublePrecision)
    expect(p.credits).toBe(1.5);
  });

  it("keeps the new fields optional — a legacy payload still parses", () => {
    const p = GenerationActivityPayloadSchema.parse({ source: "task" });
    expect(p.kind).toBeUndefined();
    expect(p.fileUrl).toBeUndefined();
    expect(p.thumbnailUrl).toBeUndefined();
    expect(p.credits).toBeUndefined();
  });

  it("rejects a non-media kind (only image/video/audio may reach the preview)", () => {
    expect(() =>
      GenerationActivityPayloadSchema.parse({ source: "task", kind: "tts" }),
    ).toThrow();
  });

  it("accepts credits === 0 (a real zero-cost generation)", () => {
    const p = GenerationActivityPayloadSchema.parse({ source: "task", credits: 0 });
    expect(p.credits).toBe(0);
  });
});

describe("AssetActivityPayloadSchema (upload) — already carries fileUrl + kind", () => {
  it("parses an upload payload unchanged", () => {
    const p = AssetActivityPayloadSchema.parse({
      fileUrl: "https://cdn.example/x.png",
      kind: "image",
    });
    expect(p.fileUrl).toBe("https://cdn.example/x.png");
    expect(p.kind).toBe("image");
  });
});

/**
 * A feed entry.
 * @param over - What differs from a member removed by someone else.
 * @returns The entry.
 */
function entry(over: Partial<ProjectActivityEntry>): ProjectActivityEntry {
  return {
    id: "a-1",
    projectId: "p",
    actorUserId: "u-owner",
    actorName: "Owner",
    type: "member:removed",
    spaceId: null,
    nodeId: null,
    taskId: null,
    payload: { targetUserId: "u-bob", previousRole: "editor" },
    restored: false,
    createdAt: 0,
    ...over,
  };
}

describe("isMemberLeave", () => {
  it("is true for a removal whose actor removed themselves", () => {
    expect(isMemberLeave(entry({ actorUserId: "u-bob" }))).toBe(true);
  });

  it("is false for a member removed by someone else", () => {
    expect(isMemberLeave(entry({}))).toBe(false);
  });

  it("is false for a removal with no actor, even when the payload names no target", () => {
    expect(isMemberLeave(entry({ actorUserId: null, payload: {} }))).toBe(false);
  });

  it("is false for any other type whose payload names the actor", () => {
    expect(isMemberLeave(entry({ type: "member:role-changed", actorUserId: "u-bob" }))).toBe(false);
  });
});
