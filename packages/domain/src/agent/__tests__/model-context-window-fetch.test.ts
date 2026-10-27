// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading the main model's window off OpenRouter's endpoint list (inner#1567,
 * design 6.1): the smallest endpoint's figure, cached, and nothing when the
 * directory cannot be read, so the caller falls back to the configured window.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

const policy = { timeoutMs: 1000, ttlMs: 300_000, retryMs: 30_000 };

/**
 * An endpoint list the way OpenRouter answers it.
 * @param lengths - Each endpoint's context length.
 * @returns The response.
 */
function endpoints(lengths: number[]): Response {
  return new Response(JSON.stringify({ data: { endpoints: lengths.map((context_length) => ({ context_length })) } }));
}

beforeEach(() => {
  vi.resetModules();
  httpRequestMock.mockReset();
});

describe("resolveModelContextWindow", () => {
  it("reads the smallest endpoint window once and serves it from the cache", async () => {
    httpRequestMock.mockResolvedValue(endpoints([1_048_576, 1_000_000, 1_040_000]));
    const { resolveModelContextWindow } = await import("@domain/agent/model-context-window.js");

    expect(await resolveModelContextWindow("deepseek/deepseek-v4.1-flash-1017", policy)).toBe(1_000_000);
    expect(await resolveModelContextWindow("deepseek/deepseek-v4.1-flash-1017", policy)).toBe(1_000_000);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(String(httpRequestMock.mock.calls[0]?.[0])).toBe(
      "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints",
    );
  });

  it("has no window when the directory fails, and does not ask again inside the cooldown", async () => {
    httpRequestMock.mockRejectedValue(new Error("directory unavailable"));
    const { resolveModelContextWindow } = await import("@domain/agent/model-context-window.js");

    expect(await resolveModelContextWindow("vendor/model", policy)).toBeUndefined();
    expect(await resolveModelContextWindow("vendor/model", policy)).toBeUndefined();
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });
});
