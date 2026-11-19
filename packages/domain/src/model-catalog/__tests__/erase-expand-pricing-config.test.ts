// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two models erase and expand run (inner#1306 execution design §10.4, §10.5 model rows): `bria-video-eraser-mask` on
 * `bria/video-eraser/mask`, priced at 0.05 USD per second rounded up and capped at 5 s; `wan-2.1-14b-vace` on
 * `wavespeed-ai/wan-2.1-14b-vace`, 0.30 USD for a 5 s request and 0.45 USD for 6–10 s (the quotes measured at the provider).
 * Both are internal, tool-only entries. Credits are 100 per USD at multiplier 1.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateModelCredits, getFullModelConfig, inputRefusalFor } from "@domain/model-catalog/model-catalog.js";
import { provider } from "@domain/provider/instance.js";
import { allProviderKeyNames, restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

const URL = "https://assets.example.test/video/source.mp4";

/** Inject dummy provider keys and multiplier 1, then clear the catalog cache. @throws {Error} On invalid real declarations. */
function configure(): void {
  useEnvWithKeys(allProviderKeyNames(), { CREDIT_MULTIPLIER: "1" });
}

beforeEach(() => { configure(); });
afterEach(() => { restoreProcessEnv(); });

describe("erase and expand model declarations (execution design §10.4, §10.5)", () => {
  it.each([
    ["bria-video-eraser-mask", "bria/video-eraser/mask"],
    ["wan-2.1-14b-vace", "wavespeed-ai/wan-2.1-14b-vace"],
  ])("declares %s as one internal tool-only video entry on %s", (name, endpoint) => {
    const found = getFullModelConfig("video").models.filter((model) => model.name === name);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name, tier: "internal" });
    // inner#1306 §11.5: the upstream is provider's binding, not the catalog's.
    expect(provider().config.models[name]).toEqual([expect.objectContaining({ upstream: "wavespeed", model_id: endpoint })]);
  });

  it.each([
    [1, 5], [1.000001, 10], [3, 15], [4.999999, 25], [5, 25],
  ])("prices a Bria erase of %s s at %s credits", async (seconds, credits) => {
    expect(await estimateModelCredits("bria-video-eraser-mask", { params: { video: URL, mask_video: URL, copy_audio: false }, durations: { video: [seconds] }, sources: ["video"] }))
      .toEqual({ credits, bound: "exact" });
  });

  // inner#1306 §11.5: the eraser's one to five seconds per call is the vendor's limit, a provider reject.
  it.each([[0.5, { min: 1 }], [5.1, { max: 5 }]])("refuses a Bria erase of %s s at its seconds limit", async (seconds, bound) => {
    expect(await inputRefusalFor("bria-video-eraser-mask", { params: { video: URL, mask_video: URL, copy_audio: false }, durations: { video: [seconds] }, sources: ["video"] }))
      .toMatchObject({ limit: { field: "video", measure: "seconds", ...bound } });
  });

  it.each([[5, 30], [10, 45]])("prices a VACE window requesting %s s at %s credits", async (duration, credits) => {
    expect(await estimateModelCredits("wan-2.1-14b-vace", { params: { duration, size: "832*480" }, durations: { video: [duration] }, sources: ["video"] }))
      .toEqual({ credits, bound: "exact" });
  });
});
