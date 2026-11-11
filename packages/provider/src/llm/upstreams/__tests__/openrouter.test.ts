// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { openrouter } from "../openrouter.js";

/**
 * The context window an endpoint list answers.
 * @param endpoints - The endpoints as OpenRouter lists them.
 * @returns The window, or undefined.
 */
const windowOf = (endpoints: unknown): number | undefined => openrouter.catalog!.contextWindow.read({ data: { endpoints } });

describe("OpenRouter's context window, from its endpoint list", () => {
  it("takes the smallest endpoint context length (H5)", () => {
    expect(windowOf([{ context_length: 1_048_576 }, { context_length: 1_000_000 }, { context_length: 1_040_000 }, { context_length: 1_048_575 }])).toBe(1_000_000);
  });

  it("ignores endpoints with no positive context length", () => {
    expect(windowOf([{ context_length: null }, {}, { context_length: 0 }, { context_length: -1 }, { context_length: 1_048_576 }, { context_length: 1_040_000 }])).toBe(1_040_000);
  });

  it("has no answer when no endpoint states a context length", () => {
    expect(windowOf([{ context_length: null }, {}, { context_length: 0 }])).toBeUndefined();
  });

  it("has no answer for an empty endpoint list, or an answer without one", () => {
    expect(windowOf([])).toBeUndefined();
    expect(openrouter.catalog!.contextWindow.read({ data: {} })).toBeUndefined();
    expect(openrouter.catalog!.contextWindow.read("<html>")).toBeUndefined();
  });

  it("asks for the model's own endpoint list", () => {
    expect(openrouter.catalog!.contextWindow.url({ kind: "openrouter", base_url: "https://or.test/api/v1", key_env: "K", empty_output_wait_ms: 0 }, "deepseek/deepseek-v4.1-flash-1017"))
      .toBe("https://or.test/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints");
  });
});
