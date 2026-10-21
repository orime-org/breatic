// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio enhance model declares (inner#1305 §4.3): WaveSpeed's
 * veed/clean-audio, which takes at most 30 minutes and 512 MB, cleans speech
 * at a strength the reader picks, levels it to -16 LUFS and returns a WAV,
 * priced per started minute.
 *
 * These read the REAL config files, as the sibling catalog tests do.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { estimateModelCredits, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * The enhance entry on the wire.
 * @returns It.
 * @throws {Error} When the catalog carries no such model.
 */
function enhance(): ReturnType<typeof getModelCatalog>["audio"][number] {
  const found = getModelCatalog().audio.find((m) => m.name === "veed-clean-audio");
  if (!found) throw new Error("no veed-clean-audio in the audio catalog");
  return found;
}

describe("veed-clean-audio", () => {
  it("is a tool-only model in the enhance mode, on WaveSpeed", () => {
    expect(enhance().mode).toBe("enhance");
    expect(enhance().tier).toBe("internal");
    expect(enhance().providers.map((p) => p.name)).toEqual(["wavespeed"]);
  });

  it("caps the source at the model's 30 minutes and 512 MB", () => {
    expect(enhance().params.audio).toMatchObject({
      fill: "tool",
      accepts: "audio",
      max_total_duration: 1800,
      max_bytes: 536_870_912,
    });
  });

  it("lets the reader set the strength from 0 to 1 and fixes the level and the format", () => {
    expect(enhance().params.strength).toMatchObject({ fill: "tool", min: 0, max: 1, step: 0.05, default: 0.85 });
    expect(enhance().params.target_lufs).toMatchObject({ fill: "none", default: -16 });
    expect(enhance().params.output_format).toMatchObject({ fill: "none", default: "wav" });
  });

  it("declares the WAV it returns, so the result is stored as one", () => {
    expect(enhance().output_type).toBe("audio/wav");
  });
});

describe("what enhancing costs", () => {
  const at = async (seconds: number): Promise<number | undefined> =>
    // As the mini-tool sends it (shared `miniToolEstimateInput`): the source named as one.
    (await estimateModelCredits("veed-clean-audio", { params: { audio: "a" }, durations: { audio: [seconds] }, sources: ["audio"] }))
      ?.credits;

  // $0.014 for every started minute, at least one and at most thirty.
  it("charges per started minute, from one minute up to thirty", async () => {
    expect(await at(0)).toBeCloseTo(1.4, 6);
    expect(await at(59)).toBeCloseTo(1.4, 6);
    expect(await at(61)).toBeCloseTo(2.8, 6);
    expect(await at(1800)).toBeCloseTo(42, 6);
    expect(await at(3600)).toBeCloseTo(42, 6);
  });
});
