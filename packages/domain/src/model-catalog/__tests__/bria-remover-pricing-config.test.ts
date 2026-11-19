// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VIDEO_GENERATION_MODES } from "@breatic/shared";
import { catalogEntryOf } from "@breatic/shared/mini-tools";
import { getCanvasCapabilities, modelsForMode } from "@domain/model-catalog/mode-catalog.js";
import { estimateModelCredits, getFullModelConfig, getModelCatalog, inputRefusalFor, MODALITIES, servability } from "@domain/model-catalog/model-catalog.js";
import { provider } from "@domain/provider/instance.js";
import { allProviderKeyNames, restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

const NAME = "bria-fibo-video-background-remover";
const ENDPOINT = "bria/fibo/video-background-remover";
const URL = "https://assets.example.test/video/source.mp4";
const BODY = { video: URL, background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true };
const OFFICIAL_PRICING = { kind: "formula", base_price: 50000, discount_rate: 100, formula: '{"total_price": $min([$ceil(get_duration(video)), 60]) * base_price}' };

/** Inject only dummy provider keys and the explicit multiplier, then clear the real catalog cache.
 * @throws {Error} When the existing injected configuration or real catalog declarations are invalid.
 */
function configure(multiplier: number, availability: "dummy" | "empty" | "absent" = "dummy"): void {
  const keys = allProviderKeyNames().filter((name) => availability === "dummy" || name !== "WAVESPEED_API_KEY");
  useEnvWithKeys(keys, { CREDIT_MULTIPLIER: String(multiplier) });
}

beforeEach(() => { configure(1); });
afterEach(() => { restoreProcessEnv(); });

describe("real Bria video removal catalog declarations", () => {
  // inner#1306 §11.5: the catalog declares the model; its upstream, price and vendor limit are provider's binding.
  it("C1 declares one tool-only video edit entry with its input defaults, bound on WaveSpeed at the official formula", () => {
    const found = getFullModelConfig("video").models.filter((model) => model.name === NAME);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: NAME, mode: "edit", tier: "internal", takes_prompt: false, output_type: "video/webm",
      params: { video: { default: null, accepts: "video", fill: "tool", max_total_duration: 60 }, background_color: { default: "Transparent" }, output_container_and_codec: { default: "webm_vp9" }, preserve_audio: { default: true } },
    });
    expect(found[0]).not.toHaveProperty("providers");
    expect(provider().config.models[NAME]).toEqual([expect.objectContaining({ upstream: "wavespeed", model_id: ENDPOINT, pricing: OFFICIAL_PRICING })]);
    expect(found[0]!.params?.prompt).toBeUndefined();
    expect(MODALITIES.flatMap((modality) => getFullModelConfig(modality).models.filter((model) => model.name === NAME))).toHaveLength(1);
  });
  it("C1 preserves the existing image remover's independent model identity", () => {
    expect(getFullModelConfig("image").models.find((model) => model.name === "bria-remove-background")).toMatchObject({ name: "bria-remove-background", mode: "remove_bg" });
    expect(provider().config.models["bria-remove-background"]).toEqual(expect.arrayContaining([expect.objectContaining({ upstream: "wavespeed", model_id: "bria/remove-background" })]));
  });
  it.each(["absent", "empty"] as const)("C2 lists the video remover but cannot serve it with an %s WaveSpeed key, naming the key", (availability) => {
    configure(1, availability);
    expect(catalogEntryOf(getModelCatalog(), NAME)).toMatchObject({ name: NAME });
    expect(servability(NAME, { mode: "upstream", upstream: "wavespeed" })).toEqual({ servable: false, reason: "unconfigured", envVars: ["WAVESPEED_API_KEY"] });
  });
  it("C3 serves the exact video endpoint under a dummy key without performing a supplier call", () => {
    const served = getModelCatalog().video.filter((model) => model.name === NAME);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ name: NAME, modality: "video", mode: "edit", tier: "internal", takes_prompt: false, output_type: "video/webm" });
    expect(catalogEntryOf(getModelCatalog(), NAME)).toEqual(served[0]);
  });
  it.each(VIDEO_GENERATION_MODES)("C4 keeps the served edit-only remover out of Generate mode %s", (mode) => {
    expect(catalogEntryOf(getModelCatalog(), NAME)).toMatchObject({ name: NAME, mode: "edit" });
    const result = modelsForMode("video", mode);
    expect(result.available).toBe(true);
    if (result.available) expect(result.models.map((model) => model.name)).not.toContain(NAME);
  });
  it("C4 keeps the seven existing generation capabilities without adding edit or analysis", () => {
    expect(catalogEntryOf(getModelCatalog(), NAME)).toMatchObject({ name: NAME, mode: "edit" });
    const video = getCanvasCapabilities().find((node) => node.nodeType === "video");
    expect(video?.modes.map((mode) => mode.mode)).toEqual([...VIDEO_GENERATION_MODES]);
  });
  it("C11 keeps every modality count of the finalized catalog", () => {
    const counts = Object.fromEntries(MODALITIES.map((modality) => [modality, getFullModelConfig(modality).models.length]));
    expect(counts).toEqual({ image: 21, video: 33, audio: 10, tts: 8, three_d: 3 });
    expect(MODALITIES.reduce((sum, modality) => sum + getFullModelConfig(modality).models.length, 0)).toBe(75);
  });
});

// Independent literal expectations: ceil seconds, then cap at sixty, then the catalog's multiplier. A source past sixty
// seconds is the vendor's limit: no upstream takes it, so it has no quote.
const PRICES = [
  { duration: 0.001, one: 5, two: 10, fractional: 6.25 },
  { duration: 1, one: 5, two: 10, fractional: 6.25 },
  { duration: 1.000001, one: 10, two: 20, fractional: 12.5 },
  { duration: 4.999999, one: 25, two: 50, fractional: 31.25 },
  { duration: 5, one: 25, two: 50, fractional: 31.25 },
  { duration: 5.000001, one: 30, two: 60, fractional: 37.5 },
  { duration: 5.055, one: 30, two: 60, fractional: 37.5 },
  { duration: 59, one: 295, two: 590, fractional: 368.75 },
  { duration: 59.000001, one: 300, two: 600, fractional: 375 },
  { duration: 60, one: 300, two: 600, fractional: 375 },
];
const QUOTES = PRICES.flatMap(({ duration, one, two, fractional }) => [
  { duration, multiplier: 1, credits: one }, { duration, multiplier: 2, credits: two }, { duration, multiplier: 1.25, credits: fractional },
]);

describe("C6/C10 real served Bria formula on every positive duration boundary", () => {
  it.each(QUOTES)("returns the complete exact quote at d=$duration and multiplier=$multiplier", async ({ duration, multiplier, credits }) => {
    configure(multiplier);
    expect(await estimateModelCredits(NAME, { params: BODY, durations: { video: [duration] }, sources: ["video"] })).toEqual({ credits, bound: "exact" });
  });
});

describe("the vendor's sixty-second limit", () => {
  it.each([60.000001, 600])("refuses a %s s source with the seconds limit", async (duration) => {
    expect(await inputRefusalFor(NAME, { params: BODY, durations: { video: [duration] }, sources: ["video"] })).toMatchObject({ limit: { field: "video", measure: "seconds", max: 60 } });
  });
});
