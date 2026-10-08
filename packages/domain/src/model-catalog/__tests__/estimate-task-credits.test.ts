// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * estimateTaskCredits — the estimate the /canvas/tasks route requires a
 * caller's balance to cover before enqueue. It prices the run the request
 * describes by the model's pricing contract, taking a source's length as zero
 * (the lower bound), and never asks for less than MIN_TASK_CREDIT_COST.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initCore } from "@breatic/core";
import {
  estimateModelCredits,
  estimateTaskCredits,
  getModelCatalog,
  MIN_TASK_CREDIT_COST,
  resetModelCatalog,
} from "../model-catalog.js";
import { allProviderKeyNames, restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

// The catalog carries a model only when its provider has a key; without this
// the catalog is empty on CI and every case below prices nothing.
beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("estimateTaskCredits", () => {
  it("falls back to MIN_TASK_CREDIT_COST when no model is specified", async () => {
    expect(await estimateTaskCredits(undefined, { params: {} })).toBe(MIN_TASK_CREDIT_COST);
  });

  it("falls back to MIN_TASK_CREDIT_COST for an unknown model name", async () => {
    expect(await estimateTaskCredits("no-such-model-xyz", { params: {} })).toBe(MIN_TASK_CREDIT_COST);
  });

  it("prices the params the request carries", async () => {
    // wan-3.0 text-to-video: $0.10 a second at 1080p, 95% discount rate.
    expect(
      await estimateTaskCredits("wan-3.0-text-to-video", { params: { resolution: "1080p", duration: 10 } }),
    ).toBeCloseTo(190, 6);
  });

  it("prices the prompt a per-character model reads", async () => {
    // MiniMax Speech 2.8 HD: $0.10 per thousand characters.
    expect(
      await estimateTaskCredits("minimax-speech-2.8-hd", { params: {}, prompt: "x".repeat(10_000) }),
    ).toBeCloseTo(100, 6);
  });

  it("never asks for less than the floor", async () => {
    // A run priced by a source whose length the server does not know prices at zero.
    expect(await estimateTaskCredits("dreamactor-v2", { params: { image: "i", video: "v" } })).toBe(
      MIN_TASK_CREDIT_COST,
    );
  });

  it("converts by the deployment's credit multiplier", async () => {
    const env: Record<string, string | undefined> = { ...process.env, CREDIT_MULTIPLIER: "2" };
    for (const name of allProviderKeyNames()) env[name] = "test-key";
    initCore(env);
    resetModelCatalog();
    try {
      expect(await estimateTaskCredits("grok-imagine-image-v2.0-text-to-image", { params: {} })).toBeCloseTo(10, 6);
    } finally {
      useFullCatalog();
    }
  });

  it("carries the multiplier on the catalog the panels estimate with", () => {
    expect(getModelCatalog().credit_multiplier).toBeGreaterThan(0);
  });

  it("estimates a model at its defaults with how the number bounds the charge", async () => {
    // wan-3.0 text-to-video defaults: 720p, 5 seconds.
    expect(await estimateModelCredits("wan-3.0-text-to-video", { params: {} })).toEqual({
      credits: expect.closeTo(47.5, 6) as number,
      bound: "exact",
    });
    expect(await estimateModelCredits("minimax-speech-2.8-hd", { params: {} })).toMatchObject({
      bound: "per_thousand_chars",
    });
  });

  it("answers nothing for a model the catalog does not serve", async () => {
    expect(await estimateModelCredits("no-such-model-xyz", { params: {} })).toBeUndefined();
  });

  it("MIN_TASK_CREDIT_COST is a positive integer floor", () => {
    expect(Number.isInteger(MIN_TASK_CREDIT_COST)).toBe(true);
    expect(MIN_TASK_CREDIT_COST).toBeGreaterThan(0);
  });
});

describe("style images on a model that prices each picture (inner#828)", () => {
  it("prices MiniMax H3's style images as pictures in its reference list", async () => {
    const set = { duration: 6, resolution: "1080p" };
    const withStyle = await estimateModelCredits("minimax-h3-reference-to-video", {
      params: { ...set, images: ["a", "b", "c", "d"], style_images: ["s1", "s2", "s3"] },
    });
    const sevenPictures = await estimateModelCredits("minimax-h3-reference-to-video", {
      params: { ...set, images: ["a", "b", "c", "d", "s1", "s2", "s3"] },
    });
    const fourPictures = await estimateModelCredits("minimax-h3-reference-to-video", {
      params: { ...set, images: ["a", "b", "c", "d"] },
    });
    expect(withStyle).toEqual(sevenPictures);
    expect(withStyle?.credits).toBeGreaterThan(fourPictures?.credits ?? Infinity);
  });
});
