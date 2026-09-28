// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — which upstream a model runs on, and the key to reach it.
 *
 * The worker has answered this since #1672 (`resolveModel`), and the voice
 * catalog endpoint needs the same answer: it calls whichever vendor this
 * deployment resolved to, in that vendor's own value domain. Two copies of
 * the rule would drift the moment a priority or a key name changes, so the
 * rule lives here and the worker's `resolveModel` builds its transport DTO
 * on top of it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initCore } from "@breatic/core";

import { resolveActiveProvider } from "../resolve-active-provider.js";
import { resetModelCatalog } from "../model-catalog.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost:5432/breatic_test",
};

/**
 * Injects a deployment's provider keys and clears the catalog cache.
 * @param keys - Env vars to set on top of the schema's required ones.
 */
function deployWith(keys: Record<string, string>): void {
  initCore({ ...BASE_ENV, ...keys });
  resetModelCatalog();
}

afterAll(() => {
  initCore(process.env);
  resetModelCatalog();
});

describe("resolveActiveProvider (#1960)", () => {
  beforeAll(() => {
    deployWith({});
  });

  it("resolves the model's WaveSpeed endpoint when the key is set", () => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
    const resolved = resolveActiveProvider("tts", "elevenlabs-v3");
    expect(resolved.providerName).toBe("wavespeed");
    expect(resolved.apiKey).toBe("ws-key");
    expect(resolved.modelId).toBe("elevenlabs/eleven-v3");
  });

  it("carries the provider's connection settings from providers.yaml", () => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
    const resolved = resolveActiveProvider("tts", "elevenlabs-v3");
    expect(resolved.baseUrl).toBe("https://api.wavespeed.ai/api/v3");
    expect(typeof resolved.timeout).toBe("number");
    expect(resolved.timeout).toBeGreaterThan(0);
  });

  it("hands back the model config and the provider entry, not just names", () => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
    const resolved = resolveActiveProvider("tts", "elevenlabs-v3");
    // The worker builds cost and extra params off these, so the resolution
    // stays one rule rather than one rule plus a second lookup.
    expect(resolved.modelConfig.name).toBe("elevenlabs-v3");
    expect(resolved.providerEntry.model_id).toBe("elevenlabs/eleven-v3");
  });

  it("refuses when no provider of the model has a key", () => {
    deployWith({});
    expect(() => resolveActiveProvider("tts", "elevenlabs-v3")).toThrow(
      /active API key/,
    );
  });

  it("refuses when the model is not in the catalog", () => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
    expect(() => resolveActiveProvider("tts", "no-such-model")).toThrow(
      /not found/,
    );
  });
});
