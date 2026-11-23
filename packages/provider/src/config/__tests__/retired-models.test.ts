// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Models the catalog has retired keep their bindings so runs opened on them before the change finish there; every
 * bound model outside the catalog is one of `RETIRED`.
 */

import { describe, expect, it } from "vitest";
import { RETIRED } from "../../media/wavespeed/__tests__/departures.js";
import { createProvider } from "../../provider.js";
import { catalog, shipped } from "./shipped.js";

const config = shipped();
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });

/**
 * The upstreams a model is bound on, in order.
 * @param model - The model.
 * @returns The upstreams.
 */
const upstreamsOf = (model: string): string[] => (provider.config.models[model] ?? []).map((b) => b.upstream);

describe("retired models", () => {
  it("are exactly the bound models outside the catalog", () => {
    const names = new Set(catalog().models.map((m) => m.name));
    expect(Object.keys(config.media.models).filter((m) => !names.has(m)).sort()).toEqual([...RETIRED].sort());
  });

  it("keep Gemini 3.1 bound on all three upstreams, so a run opened on it finishes there", () => {
    expect(upstreamsOf("gemini-3.1-flash-text-to-speech")).toEqual(["wavespeed", "fal", "sandbase"]);
  });

  it("leave OmniVoice out of the catalog, its weights being licensed for non-commercial use only, and keep it bound on WaveSpeed (inner#1778)", () => {
    expect(catalog().models.some((m) => m.name === "omnivoice-voice-clone")).toBe(false);
    expect(RETIRED.has("omnivoice-voice-clone")).toBe(true);
    expect(upstreamsOf("omnivoice-voice-clone")).toEqual(["wavespeed"]);
  });
});
