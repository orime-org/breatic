// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The main model's context window (inner#1567, design 6.1).
 *
 * OpenRouter keeps a conversation on one upstream, so the window is the
 * smallest `context_length` among the model's endpoints: sticking to the
 * smallest provider at the model-level 1,048,576 would overflow. The endpoint
 * figures are the ones OpenRouter listed for deepseek/deepseek-v4.1-flash-1017
 * on 2026-10-25 (H5).
 */

import { describe, expect, it } from "vitest";
import { minEndpointContext, windowOrFallback } from "@domain/agent/model-context-window.js";

describe("minEndpointContext", () => {
  it("takes the smallest endpoint context length (H5)", () => {
    expect(
      minEndpointContext([
        { context_length: 1_048_576 },
        { context_length: 1_000_000 },
        { context_length: 1_040_000 },
        { context_length: 1_048_575 },
      ]),
    ).toBe(1_000_000);
  });

  it("ignores endpoints with no positive context length", () => {
    expect(
      minEndpointContext([
        { context_length: null },
        {},
        { context_length: 0 },
        { context_length: -1 },
        { context_length: 1_048_576 },
        { context_length: 1_040_000 },
      ]),
    ).toBe(1_040_000);
  });

  it("has no answer when no endpoint states a context length", () => {
    expect(minEndpointContext([{ context_length: null }, {}, { context_length: 0 }])).toBeUndefined();
  });

  it("has no answer for an empty endpoint list", () => {
    expect(minEndpointContext([])).toBeUndefined();
  });
});

describe("windowOrFallback", () => {
  it("keeps a resolved window", () => {
    expect(windowOrFallback(200_000, 1_000_000)).toBe(200_000);
  });

  it("uses the fallback when the window is unknown", () => {
    expect(windowOrFallback(undefined, 1_000_000)).toBe(1_000_000);
  });
});
