// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 execution design §11.5: a video mini-tool's model calls take the configured upstream, which admission
 * freezes into the run's plan.
 */
import { describe, expect, it, vi } from "vitest";
import type * as Core from "@breatic/core";
import { miniToolModelRoute } from "@domain/mini-tool/model-call-admission.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return { ...core, getMiniToolsConfig: (): Core.MiniToolsConfig => ({ ...core.getMiniToolsConfig(), model_upstream: "configured-upstream" }) };
});

describe("the route of a video mini-tool's model calls", () => {
  it("is the configured upstream", () => {
    expect(miniToolModelRoute()).toEqual({ mode: "upstream", upstream: "configured-upstream" });
  });
});
