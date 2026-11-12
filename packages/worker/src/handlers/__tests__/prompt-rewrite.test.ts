// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Nano Banana 2's prompt is rewritten by an LLM into the structured JSON shape before the run is planned
 * (inner#1743); when the rewrite fails or answers no JSON, the shape the catalog writes itself is sent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ warn: vi.fn(), prepare: vi.fn() }));

vi.mock("@breatic/core", () => ({ logger: { warn: h.warn } }));
vi.mock("@breatic/domain", () => ({
  generateTextRetry: vi.fn(),
  provider: () => ({ llm: { prepare: h.prepare } }),
}));

import { generateTextRetry } from "@breatic/domain";
import { rewrittenPrompt, REWRITTEN_MODELS } from "@worker/handlers/prompt-rewrite.js";

const mockLlm = vi.mocked(generateTextRetry);

const CAMERA = { enable_camera: true, camera: "ARRI Alexa 35", lens: "Cooke S4/i", focal_length: 85, aperture: "f/4" };
/** The shape the catalog writes when no rewrite is used. */
const FALLBACK = JSON.stringify({ subject: "a cat" });
/** A deadline nothing here reaches. */
const LATER = Date.now() + 60_000;

beforeEach(() => {
  mockLlm.mockReset();
  h.warn.mockReset();
  h.prepare.mockReset();
  h.prepare.mockReturnValue({ model: "mock-model", options: { temperature: 0.3 } });
});

describe("rewrittenPrompt", () => {
  it("rewrites Nano Banana 2 alone", () => {
    expect([...REWRITTEN_MODELS]).toEqual(["nano-banana-2"]);
  });

  it("uses the model's rewrite when it answers JSON", async () => {
    mockLlm.mockResolvedValue({ text: 'Here: {"subject":"a cat","lighting":"dusk"}' } as never);

    expect(JSON.parse(await rewrittenPrompt("a cat", {}, FALLBACK, LATER))).toEqual({ subject: "a cat", lighting: "dusk" });
  });

  it("tells the model the camera the user turned on", async () => {
    mockLlm.mockResolvedValue({ text: '{"subject":"a cat"}' } as never);

    await rewrittenPrompt("a cat", CAMERA, FALLBACK, LATER);

    const { messages } = mockLlm.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(messages[0]!.content).toContain("Camera info: ARRI Alexa 35, Cooke S4/i, 85mm, f/4.");
    expect(messages[0]!.content).toContain('Description: "a cat"');
  });

  it("asks under the task's deadline", async () => {
    mockLlm.mockResolvedValue({ text: '{"subject":"a cat"}' } as never);

    await rewrittenPrompt("a cat", {}, FALLBACK, LATER);

    expect(mockLlm).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
  });

  it("sends the catalog's shape when the rewrite fails, and says so", async () => {
    mockLlm.mockRejectedValue(new Error("llm down"));

    expect(await rewrittenPrompt("a cat", CAMERA, FALLBACK, LATER)).toBe(FALLBACK);
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "nano_banana_prompt_rewrite_failed");
  });

  it("sends the catalog's shape when the model answers no JSON, or broken JSON", async () => {
    mockLlm.mockResolvedValue({ text: "no braces here" } as never);
    expect(await rewrittenPrompt("a cat", {}, FALLBACK, LATER)).toBe(FALLBACK);

    mockLlm.mockResolvedValue({ text: "{not json}" } as never);
    expect(await rewrittenPrompt("a cat", {}, FALLBACK, LATER)).toBe(FALLBACK);
  });
});
