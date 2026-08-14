// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * resolveModel / validateParams behavior pins (#1672 model-config
 * unification). Written GREEN against the pre-migration worker loader,
 * then kept green across the switch to domain's getFullModelConfig — the
 * transport connection fields (baseUrl / apiKey / timeout / ...) are the
 * worker's production critical path, so every field is pinned against the
 * real config/models yaml.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";
import { resolveModel, validateParams } from "@worker/providers/shared.js";

// Stand in for the worker entry (composition root): inject the schema's
// required vars plus deterministic API keys so provider resolution is
// reproducible regardless of the developer's real .env.
beforeAll(() => {
  initCore({
    DATABASE_URL: "postgres://localhost:5432/breatic_test",
    WAVESPEED_API_KEY: "test-wavespeed-key",
    TOPAZ_API_KEY: "test-topaz-key",
  });
});

describe("resolveModel (#1672 behavior pins)", () => {
  it("resolves every transport connection field for image/midjourney-v7", () => {
    const resolved = resolveModel("image", "midjourney-v7");
    expect(resolved).toMatchObject({
      modelName: "midjourney-v7",
      providerName: "wavespeed",
      modelId: "midjourney/text-to-image",
      baseUrl: "https://api.wavespeed.ai/api/v3",
      apiKey: "test-wavespeed-key",
      timeout: 120,
      costPerCall: 10,
      maxConcurrency: 50,
      mode: "t2i",
    });
    expect(resolved.tokenPrice).toBeUndefined();
    expect(resolved.creditPrice).toBeUndefined();
    expect(resolved.litellmModel).toBeUndefined();
  });

  it("carries per-provider credit_price through (image/topaz-upscale)", () => {
    const resolved = resolveModel("image", "topaz-upscale");
    expect(resolved).toMatchObject({
      providerName: "topaz",
      modelId: "enhance",
      baseUrl: "https://api.topazlabs.com/image/v1",
      apiKey: "test-topaz-key",
      creditPrice: 0.0005,
    });
  });

  it("falls through priorities to the first provider with a key (nano-banana-2: google keyless -> wavespeed)", () => {
    const resolved = resolveModel("image", "nano-banana-2");
    expect(resolved.providerName).toBe("wavespeed");
    expect(resolved.modelId).toBe("google/nano-banana-2/text-to-image");
  });

  it("throws for an unknown model", () => {
    expect(() => resolveModel("image", "no-such-model")).toThrow(/not found/);
  });

  it("throws when no provider has an active key", () => {
    // fish-s2-pro's only provider needs FISH_API_KEY, which is not injected.
    expect(() => resolveModel("tts", "fish-s2-pro")).toThrow(/active API key/);
  });
});

describe("validateParams (#1672 behavior pins)", () => {
  it("drops unknown params, keeps valid ones, and fills defaults", () => {
    const [name, cleaned] = validateParams("image", "midjourney-v7", {
      aspect_ratio: "16:9",
      bogus_param: 1,
    });
    expect(name).toBe("midjourney-v7");
    expect(cleaned.aspect_ratio).toBe("16:9");
    expect("bogus_param" in cleaned).toBe(false);
    expect(cleaned.stylize).toBe(100);
    expect(cleaned.chaos).toBe(0);
    expect(cleaned.resolution).toBe("2k");
  });

  it("replaces out-of-enum values with the default", () => {
    const [, cleaned] = validateParams("image", "midjourney-v7", {
      aspect_ratio: "21:9",
    });
    expect(cleaned.aspect_ratio).toBe("1:1");
  });

  it("pins the talking-head model's declaration: two sources, no prompt (#1935)", () => {
    // The panel makes two decisions about this model by reading what it does
    // NOT declare: it demands no prompt (`params.prompt != null` in the video
    // panel's view model) and it renders no params pill (none of the four the
    // pill edits). Both read the catalog, so a `prompt` added here -- the
    // obvious edit when someone gives this mode a dialogue script (#1936), or
    // a copy-paste from another model -- would silently switch the demand back
    // on. This is where that shows up: `validateParams` keeps a declared key
    // and drops an undeclared one, so the last assertion is the pin.
    //
    // The input shape is synthetic on purpose. Production never sends a prompt
    // through this pass -- `runAigcDirect` lifts it out of the params first and
    // carries it to the provider as its own argument -- so this is not a claim
    // about where a typed prompt goes. It is a claim about the catalog.
    const [name, cleaned] = validateParams("video", "omnihuman-1.5", {
      image: "https://cdn/portrait.png",
      audio: "https://cdn/speech.mp3",
      prompt: "a drone shot over a canyon",
    });
    expect(name).toBe("omnihuman-1.5");
    expect(cleaned.image).toBe("https://cdn/portrait.png");
    expect(cleaned.audio).toBe("https://cdn/speech.mp3");
    expect(cleaned.seed).toBe(-1);
    expect("prompt" in cleaned).toBe(false);
  });
});
