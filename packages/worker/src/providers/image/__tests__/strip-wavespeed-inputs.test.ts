// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// The strip helper logs an observable warn per stripped param; the core
// logger is a lazy env-reading Proxy, so tests replace it with a spy
// (vi.hoisted — the mock factory is hoisted above a plain const).
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, logger: { warn: warnSpy } };
});

import { stripWavespeedPromptOnlyInputs } from "@worker/providers/image/index.js";

/**
 * Builds the minimal resolved-endpoint shape the helper reads.
 * @param over - Field overrides.
 * @returns A resolved-endpoint stub.
 */
function resolved(
  over: Partial<{ providerName: string; modelId: string; modelName: string }> = {},
): { providerName: string; modelId: string; modelName: string } {
  return {
    providerName: "wavespeed",
    modelId: "bytedance/seedream-v5.0-lite",
    modelName: "seedream-5.0-lite",
    ...over,
  };
}

describe("stripWavespeedPromptOnlyInputs — #1664 gap 1 (no silent image-input drop)", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it("strips images + style_images on a WaveSpeed prompt-only endpoint, warning per param", () => {
    const out = stripWavespeedPromptOnlyInputs(resolved(), {
      prompt_extras: 1,
      images: ["a.png"],
      style_images: ["s.png"],
    });
    expect("images" in out).toBe(false);
    expect("style_images" in out).toBe(false);
    expect(out.prompt_extras).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("returns the params untouched for a non-wavespeed provider", () => {
    const params = { images: ["a.png"], style_images: ["s.png"] };
    const out = stripWavespeedPromptOnlyInputs(
      resolved({ providerName: "google", modelId: "gemini-3-pro-image-preview" }),
      params,
    );
    expect(out).toBe(params); // same reference — nothing to strip
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps image inputs on a WaveSpeed /edit endpoint (edit variants accept them)", () => {
    const out = stripWavespeedPromptOnlyInputs(
      resolved({
        modelId: "google/nano-banana-pro/edit",
        modelName: "nano-banana-pro-edit",
      }),
      { images: ["a.png"], style_images: ["s.png"] },
    );
    expect(out.images).toEqual(["a.png"]);
    expect(out.style_images).toEqual(["s.png"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("exempts Midjourney — its WaveSpeed t2i natively takes a style reference (sref)", () => {
    const out = stripWavespeedPromptOnlyInputs(
      resolved({
        modelId: "midjourney/text-to-image",
        modelName: "midjourney-v7",
      }),
      { style_images: ["s.png"] },
    );
    expect(out.style_images).toEqual(["s.png"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not mutate the caller's params object when stripping", () => {
    const params = { images: ["a.png"] };
    stripWavespeedPromptOnlyInputs(resolved(), params);
    expect(params.images).toEqual(["a.png"]);
  });
});
