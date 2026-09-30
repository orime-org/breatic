// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Nano Banana 2's camera controls have no upstream field: the family writes
 * them into the prompt, and only when the reader turned the camera on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The prompt is rewritten by an LLM through @breatic/domain; stubbed so the
// test is hermetic.
vi.mock("@breatic/core", () => ({ logger: { warn: (): undefined => undefined } }));
vi.mock("@breatic/domain", () => ({
  generateTextRetry: vi.fn(),
  getModel: vi.fn(() => "mock-model"),
}));

import { generateTextRetry } from "@breatic/domain";
import nanoBanana from "@worker/providers/families/nano-banana.js";

const mockLlm = vi.mocked(generateTextRetry);

const CAMERA = {
  camera: "ARRI Alexa 35",
  lens: "Cooke S4/i",
  focal_length: 85,
  aperture: "f/4",
};

describe("nano-banana family", () => {
  beforeEach(() => {
    mockLlm.mockReset();
    // The fallback path builds the JSON prompt deterministically.
    mockLlm.mockRejectedValue(new Error("llm down"));
  });

  it("covers the catalog's Nano Banana 2", () => {
    expect([...nanoBanana.MODELS]).toEqual(["nano-banana-2"]);
  });

  it("keeps all five camera params out of the upstream body", () => {
    expect([...nanoBanana.CONSUMES].sort()).toEqual(
      ["aperture", "camera", "enable_camera", "focal_length", "lens"],
    );
  });

  it("writes the camera into the prompt when the camera is on", async () => {
    const { prompt, fields } = await nanoBanana.prepare("a cat", { enable_camera: true, ...CAMERA });

    expect(JSON.parse(prompt)).toEqual({
      subject: "a cat",
      technical: { camera: "ARRI Alexa 35", lens: "Cooke S4/i", focal_length: "85mm", aperture: "f/4" },
    });
    expect(fields).toEqual({});
  });

  it("leaves the camera out when it is off, though its defaults are filled", async () => {
    const { prompt } = await nanoBanana.prepare("a cat", { enable_camera: false, ...CAMERA });

    expect(JSON.parse(prompt)).toEqual({ subject: "a cat" });
  });

  it("uses the model's rewrite when it answers JSON", async () => {
    mockLlm.mockResolvedValue({ text: 'Here: {"subject":"a cat","lighting":"dusk"}' } as never);

    const { prompt } = await nanoBanana.prepare("a cat", { enable_camera: false });

    expect(JSON.parse(prompt)).toEqual({ subject: "a cat", lighting: "dusk" });
  });
});
