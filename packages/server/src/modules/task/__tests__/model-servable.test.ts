// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A run of a model no upstream can serve here is refused before anything is queued, saying which model and which
 * environment variables the deployment is missing; a route naming an upstream the model is not offered through is
 * the request's own fault.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const servability = vi.hoisted(() => vi.fn());
const llmServability = vi.hoisted(() => vi.fn());
const inputRefusalFor = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof DomainModule>()),
  servability: (...args: unknown[]) => servability(...args),
  llmServability: (...args: unknown[]) => llmServability(...args),
  inputRefusalFor: (...args: unknown[]) => inputRefusalFor(...args),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  logger: { warn, info: vi.fn(), error: vi.fn() },
}));

import { loadLocales } from "@breatic/core";
import { assertLlmServable, assertServable, assertTakesInput } from "@server/modules/task/model-servable.js";

loadLocales();

beforeEach(() => {
  servability.mockReset();
});

describe("assertServable", () => {
  it("lets a servable run through, asking on its route", () => {
    servability.mockReturnValue({ servable: true });
    expect(() => assertServable("kling-v3", "Kling V3", { mode: "cheapest" })).not.toThrow();
    expect(servability).toHaveBeenCalledWith("kling-v3", { mode: "cheapest" });
  });

  it("refuses a model the deployment has no key for with 503, naming it and every missing variable", () => {
    servability.mockReturnValue({ servable: false, reason: "unconfigured", envVars: ["WAVESPEED_API_KEY", "FAL_KEY"] });
    let thrown: unknown;
    try {
      assertServable("kling-v3", "Kling V3");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ statusCode: 503 });
    expect((thrown as Error).message).toContain("Kling V3");
    expect((thrown as Error).message).toContain("WAVESPEED_API_KEY, FAL_KEY");
  });

  it("refuses a route through an upstream the model is not offered on as a validation error", () => {
    servability.mockReturnValue({ servable: false, reason: "unbound", upstream: "fal" });
    expect(() => assertServable("kling-v3", "Kling V3", { mode: "upstream", upstream: "fal" })).toThrow(
      expect.objectContaining({ statusCode: 422, message: expect.stringContaining("fal") }),
    );
  });
});

describe("assertLlmServable", () => {
  it("refuses a language model none of whose upstreams has its key with 503, naming the variables", () => {
    llmServability.mockReturnValue({ servable: false, reason: "unconfigured", envVars: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"] });
    expect(() => assertLlmServable("deepseek/deepseek-v4.1-flash-1017", "call")).toThrow(
      expect.objectContaining({ statusCode: 503, message: expect.stringContaining("DEEPSEEK_API_KEY, OPENROUTER_API_KEY") }),
    );
    // No route given leaves llmServability to its own default, the weights.
    expect(llmServability).toHaveBeenCalledWith("deepseek/deepseek-v4.1-flash-1017", "call", undefined);
  });

  it("asks on the route a resumed turn stays on", () => {
    llmServability.mockReturnValue({ servable: false, reason: "unconfigured", envVars: ["DEEPSEEK_API_KEY"] });
    expect(() => assertLlmServable("deepseek/deepseek-v4.1-flash-1017", "call", { mode: "upstream", upstream: "deepseek" })).toThrow(
      expect.objectContaining({ statusCode: 503, message: expect.stringContaining("DEEPSEEK_API_KEY") }),
    );
    expect(llmServability).toHaveBeenCalledWith("deepseek/deepseek-v4.1-flash-1017", "call", { mode: "upstream", upstream: "deepseek" });
  });

  it("lets a servable call through", () => {
    llmServability.mockReturnValue({ servable: true });
    expect(() => assertLlmServable("google/gemini-3.8-flash", "understand")).not.toThrow();
  });
});

describe("assertTakesInput (#1521)", () => {
  const input = { params: { voice_id: "Kore" }, prompt: "x".repeat(8001) };

  it("lets through a run some upstream here takes, asking with the run and its route", async () => {
    inputRefusalFor.mockResolvedValueOnce(null);
    await expect(assertTakesInput("gemini-3.8-flash-text-to-speech", "Gemini 3.8 Flash TTS", input, { mode: "cheapest" }, { userId: "u" })).resolves.toBeUndefined();
    expect(inputRefusalFor).toHaveBeenLastCalledWith("gemini-3.8-flash-text-to-speech", input, { mode: "cheapest" });
  });

  it("refuses a run none takes as a validation error naming the limit, and logs the refusal for the deployment", async () => {
    const refusal = { reason: "WaveSpeed text maxLength 8000", limit: { field: "prompt", measure: "characters", max: 8000 } };
    inputRefusalFor.mockResolvedValueOnce(refusal);
    await expect(assertTakesInput("gemini-3.8-flash-text-to-speech", "Gemini 3.8 Flash TTS", input, undefined, { userId: "u" })).rejects.toMatchObject({
      statusCode: 422,
      message: "Gemini 3.8 Flash TTS takes at most 8,000 characters in the text.",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u", model: "gemini-3.8-flash-text-to-speech", reason: "input_refused", refusal }),
      "execute_gate_rejected",
    );
  });
});
