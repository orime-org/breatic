// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The video tool limits the guide states come from `config/mini-tools.yaml`, and the eraser's seconds from its vendor's
 * provider rejects (inner#1306 execution design §11.5), so a changed limit cannot leave the guide telling the user an old one.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type * as Core from "@breatic/core";
import { loadLocales } from "@breatic/core";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";

vi.mock("@domain/mini-tool/model-call-admission.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  modelSecondsRange: (model: string): { minSeconds: number; maxSeconds: number | null } => (model === "bria-video-eraser-mask" ? { minSeconds: 2, maxSeconds: 7 } : { minSeconds: 0, maxSeconds: null }),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    getMiniToolsConfig: (): Core.MiniToolsConfig => {
      const config = structuredClone(core.getMiniToolsConfig());
      const { "video.erase": erase, "video.expand": expand, "video.lip-sync": lipSync, "video.split": split } = config.executions;
      if (erase === undefined || expand === undefined || lipSync === undefined || split === undefined) throw new Error("tracked config lacks a video tool");
      expand.max_duration_seconds = 95;
      expand.max_target_side = 2048;
      lipSync.max_people = 3;
      lipSync.max_dialogues = 11;
      split.max_outputs = 13;
      return config;
    },
  };
});

beforeAll(() => {
  loadLocales();
});

describe("video tool limits in the guide", () => {
  it("states the erase, expand, lip-sync and split limits the config sets", () => {
    const guide = renderProductGuide();
    expect(guide).toContain("a range of 2–7 s");
    expect(guide).toContain("videos up to 95 s");
    expect(guide).toContain("at most 2048 px");
    expect(guide).toContain("up to 3 people and 11 dialogue rows");
    expect(guide).toContain("up to 13 segments");
  });
});
