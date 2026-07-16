// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// The t2i path calls the DeepSeek prompt-enhancement LLM via @breatic/domain —
// mocked so tests are hermetic (and so importing the domain barrel never
// touches env-dependent code).
vi.mock("@breatic/domain", () => ({
  generateTextRetry: vi.fn(),
  getModel: vi.fn(() => "mock-model"),
}));

import { generateTextRetry } from "@breatic/domain";
import { buildRequest } from "@worker/providers/image/models/nano-banana.js";

const mockLlm = vi.mocked(generateTextRetry);

describe("nano-banana buildRequest — style merge (never clobber) + JSON style note (#1664)", () => {
  beforeEach(() => {
    mockLlm.mockReset();
  });

  it("EDIT: merges style_images INTO images (content first, style last) — the old rename clobbered i2i sources", async () => {
    const [prompt, p] = await buildRequest("swap the sky", "nano-banana-pro-edit", {
      aspect_ratio: "1:1",
      images: ["https://cdn/content.png"],
      style_images: ["https://cdn/style.png"],
    });
    expect(p.images).toEqual(["https://cdn/content.png", "https://cdn/style.png"]);
    expect("style_images" in p).toBe(false);
    const json = JSON.parse(prompt) as Record<string, unknown>;
    expect(json.subject).toBe("swap the sky");
    // Gemini has no typed style slot — the role note rides the JSON prompt.
    expect(json.style_reference).toContain("image 2");
    expect(json.style_reference).toContain("style reference");
  });

  it("EDIT: no style → images pass through untouched, no style_reference note", async () => {
    const [prompt, p] = await buildRequest("swap the sky", "nano-banana-pro-edit", {
      images: ["https://cdn/content.png"],
    });
    expect(p.images).toEqual(["https://cdn/content.png"]);
    const json = JSON.parse(prompt) as Record<string, unknown>;
    expect("style_reference" in json).toBe(false);
  });

  it("T2I (LLM fallback): a lone style image lands in images with a do-not-copy note", async () => {
    mockLlm.mockRejectedValue(new Error("llm down"));
    const [prompt, p] = await buildRequest("a cat", "nano-banana-pro", {
      aspect_ratio: "1:1",
      style_images: ["https://cdn/style.png"],
    });
    expect(p.images).toEqual(["https://cdn/style.png"]);
    const json = JSON.parse(prompt) as Record<string, unknown>;
    expect(json.subject).toBe("a cat");
    expect(json.style_reference).toContain("do not copy its subjects");
  });

  it("T2I (LLM success): the style note is injected into the LLM's JSON too", async () => {
    mockLlm.mockResolvedValue({
      text: '{"subject":"a cat, enhanced"}',
    } as Awaited<ReturnType<typeof generateTextRetry>>);
    const [prompt] = await buildRequest("a cat", "nano-banana-pro", {
      style_images: ["https://cdn/style.png"],
    });
    const json = JSON.parse(prompt) as Record<string, unknown>;
    expect(json.subject).toBe("a cat, enhanced");
    expect(json.style_reference).toContain("style reference");
  });

  it("T2I: no images at all → no images key in the API params", async () => {
    mockLlm.mockRejectedValue(new Error("llm down"));
    const [, p] = await buildRequest("a cat", "nano-banana-pro", {
      aspect_ratio: "1:1",
    });
    expect("images" in p).toBe(false);
  });
});
