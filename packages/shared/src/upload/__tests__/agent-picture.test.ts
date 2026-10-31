// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { agentPictureKeyFor, type AgentPictureSpec } from "@shared/upload/agent-picture.js";
import { previewKeyFor } from "@shared/upload/preview.js";

const SPEC: AgentPictureSpec = { version: 1, longEdge: 1024, quality: 85 };

describe("the agent picture storage key", () => {
  it.each([
    "image/2026-10-22/123_photo.png",
    "image/2026-10-22/124_external.bin",
    "video/2026-10-22/125_clip_cover.png",
  ])("keeps the registered source key intact: %s", (key) => {
    expect(agentPictureKeyFor(key, SPEC)).toBe(`${key}.agent-v1-1024-q85.jpg`);
    expect(agentPictureKeyFor(key, SPEC)).not.toBe(previewKeyFor(key));
  });

  it("keeps different encoding specifications at different keys", () => {
    const key = "image/2026-10-22/123_photo.png";
    expect(agentPictureKeyFor(key, { ...SPEC, longEdge: 768 })).toBe(`${key}.agent-v1-768-q85.jpg`);
    expect(agentPictureKeyFor(key, { ...SPEC, quality: 90 })).toBe(`${key}.agent-v1-1024-q90.jpg`);
  });

  it("deterministically retains the canonical source and requested specification", () => {
    for (const key of ["image/a.bin", "image/b.png", "video/c_cover.png"]) {
      for (const [longEdge, quality] of [[1, 1], [768, 90], [1024, 85], [4096, 100]] as const) {
        const spec: AgentPictureSpec = { version: 1, longEdge, quality };
        expect(agentPictureKeyFor(key, spec)).toBe(`${key}.agent-v1-${longEdge}-q${quality}.jpg`);
        expect(agentPictureKeyFor(key, JSON.parse(JSON.stringify(spec)) as AgentPictureSpec))
          .toBe(agentPictureKeyFor(key, spec));
      }
    }
  });
});
