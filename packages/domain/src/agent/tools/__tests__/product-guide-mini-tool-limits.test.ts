// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The video tool limits the guide states come from `config/mini-tools.yaml`, so a changed limit cannot leave the guide
 * telling the user an old one.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type * as Core from "@breatic/core";
import { loadLocales } from "@breatic/core";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    getMiniToolsConfig: (): Core.MiniToolsConfig => {
      const config = structuredClone(core.getMiniToolsConfig());
      config.executions["video.split"].max_outputs = 13;
      return config;
    },
  };
});

beforeAll(() => {
  loadLocales();
});

describe("video tool limits in the guide", () => {
  it("states the split limit the config sets", () => {
    expect(renderProductGuide()).toContain("up to 13 segments");
  });
});
