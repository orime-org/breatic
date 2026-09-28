// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One generation run against the real catalog (#2156): the request body is
 * the model's own declaration mapped upstream, the output is the prediction's
 * first output, and the cost is what WaveSpeed billed for that prediction.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { initCore } from "@breatic/core";
import type * as httpModule from "@worker/providers/http.js";

const runPredictionMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/wavespeed.js", () => ({
  runPrediction: (...args: unknown[]) => runPredictionMock(...args),
}));

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return { ...actual, queryBilling: (...args: unknown[]) => queryBillingMock(...args) };
});

const { generateAsync, validateModelParams } = await import("@worker/providers/generate.js");

beforeAll(() => {
  initCore({
    DATABASE_URL: "postgres://localhost:5432/breatic_test",
    WAVESPEED_API_KEY: "test-wavespeed-key",
  });
});

beforeEach(() => {
  runPredictionMock.mockReset();
  queryBillingMock.mockReset();
  runPredictionMock.mockResolvedValue({ outputs: ["https://cdn.test/out.mp3"], taskId: "ws-1" });
  queryBillingMock.mockResolvedValue(0.07);
});

/**
 * The endpoint, model id and body of the one prediction a run submitted.
 * @returns The three submit arguments.
 */
function submitted(): { endpoint: Record<string, unknown>; modelId: string; body: Record<string, unknown> } {
  const [endpoint, modelId, body] = runPredictionMock.mock.calls[0]! as [
    Record<string, unknown>,
    string,
    Record<string, unknown>,
  ];
  return { endpoint, modelId, body };
}

describe("generateAsync", () => {
  it("sends the prompt and params under the model's upstream names to its endpoint", async () => {
    const [model, params] = validateModelParams("tts", "minimax-speech-2.8-hd", {
      voice_id: "Wise_Woman",
      emotion: "sad",
    });

    const result = await generateAsync("tts", "read this", model, params);

    const { endpoint, modelId, body } = submitted();
    expect(endpoint).toMatchObject({ baseUrl: "https://api.wavespeed.ai/api/v3", apiKey: "test-wavespeed-key" });
    expect(modelId).toBe("minimax/speech-2.8-hd");
    expect(body).toEqual({ text: "read this", voice_id: "Wise_Woman", emotion: "sad", speed: 1, volume: 1 });
    expect(result).toEqual({ url: "https://cdn.test/out.mp3", model: "minimax-speech-2.8-hd", cost: 0.07 });
  });

  it("bills the prediction the run polled", async () => {
    await generateAsync("tts", "read this", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" });

    expect(queryBillingMock.mock.calls[0]![1]).toBe("ws-1");
  });

  it("records no cost for a prediction with no id to bill", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://cdn.test/out.mp3"], taskId: "" });

    const result = await generateAsync("tts", "read this", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" });

    expect(queryBillingMock).not.toHaveBeenCalled();
    expect(result.cost).toBe(0);
  });

  it("hands the resume context to the prediction", async () => {
    const resume = { storedTaskId: "ws-7", persistTaskId: vi.fn(), externalTaskId: "t" };

    await generateAsync("tts", "read this", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }, resume);

    expect(runPredictionMock.mock.calls[0]![3]).toBe(resume);
  });

  it("sends midjourney's one style reference as the single sref url", async () => {
    await generateAsync("image", "a fox", "midjourney", {
      style_images: ["https://cdn.test/style.png"],
    });

    const { body } = submitted();
    expect(body.sref).toBe("https://cdn.test/style.png");
    expect(body).not.toHaveProperty("style_images");
    expect(body.prompt).toBe("a fox");
  });

  it("fails when the prediction answered no output", async () => {
    runPredictionMock.mockResolvedValue({ outputs: [], taskId: "ws-1" });

    await expect(
      generateAsync("tts", "read this", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }),
    ).rejects.toThrow("No output URL after WaveSpeed polling");
  });
});
