// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
