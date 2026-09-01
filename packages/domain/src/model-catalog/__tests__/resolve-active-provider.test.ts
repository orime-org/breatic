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

  it("takes the highest-priority provider that has a key", () => {
    // elevenlabs-v3 declares elevenlabs at priority 1 and wavespeed at 2.
    deployWith({
      ELEVENLABS_API_KEY: "el-key",
      WAVESPEED_API_KEY: "ws-key",
    });
    const resolved = resolveActiveProvider("tts", "elevenlabs-v3");
    expect(resolved.providerName).toBe("elevenlabs");
    expect(resolved.apiKey).toBe("el-key");
    expect(resolved.modelId).toBe("eleven_v3");
  });

  // The same model, the same yaml — a different deployment. This is why the
  // voice endpoint has to resolve rather than read the model: the two
  // upstreams take different value domains for the same param.
  it("falls to the next provider when the first has no key", () => {
    deployWith({ WAVESPEED_API_KEY: "ws-key" });
    const resolved = resolveActiveProvider("tts", "elevenlabs-v3");
    expect(resolved.providerName).toBe("wavespeed");
    expect(resolved.apiKey).toBe("ws-key");
    expect(resolved.modelId).toBe("elevenlabs/eleven-v3");
  });

  it("carries the provider's connection settings from providers.yaml", () => {
    deployWith({ FISH_API_KEY: "fish-key" });
    const resolved = resolveActiveProvider("tts", "fish-s2-pro");
    expect(resolved.baseUrl).toBe("https://api.fish.audio");
    expect(typeof resolved.timeout).toBe("number");
    expect(resolved.timeout).toBeGreaterThan(0);
  });

  it("hands back the model config and the provider entry, not just names", () => {
    deployWith({ FISH_API_KEY: "fish-key" });
    const resolved = resolveActiveProvider("tts", "fish-s2-pro");
    // The worker builds cost / token price / extra params off these, so the
    // resolution stays one rule rather than one rule plus a second lookup.
    expect(resolved.modelConfig.name).toBe("fish-s2-pro");
    expect(resolved.providerEntry.model_id).toBe("s2-pro");
  });

  it("refuses when no provider of the model has a key", () => {
    deployWith({});
    expect(() => resolveActiveProvider("tts", "fish-s2-pro")).toThrow(
      /active API key/,
    );
  });

  // KlingAI signs a JWT per request: the access key becomes the `iss` claim
  // and the secret key signs it (https://kling.ai/document-api/apiReference/commonInfo).
  // The worker's transport takes both halves as one `access:secret` string,
  // so resolution is where the two configured vars come together.
  it("joins a provider's two credentials the way its transport reads them", () => {
    deployWith({
      KLINGAI_ACCESS_KEY: "kling-access",
      KLINGAI_SECRET_KEY: "kling-secret",
    });
    const resolved = resolveActiveProvider("video", "kling-o3-pro");
    expect(resolved.providerName).toBe("klingai");
    expect(resolved.apiKey).toBe("kling-access:kling-secret");
  });

  // Half a credential is not a credential: signing with an empty secret
  // produces a token the vendor rejects, so the deployment would look
  // configured and fail on every request instead of falling through.
  it("treats a two-credential provider with only one half as unconfigured", () => {
    deployWith({
      KLINGAI_ACCESS_KEY: "kling-access",
      WAVESPEED_API_KEY: "ws-key",
    });
    expect(resolveActiveProvider("video", "kling-o3-pro").providerName).not.toBe(
      "klingai",
    );
  });

  it("refuses when the model is not in the catalog", () => {
    deployWith({ FISH_API_KEY: "fish-key" });
    expect(() => resolveActiveProvider("tts", "no-such-model")).toThrow(
      /not found/,
    );
  });
});
