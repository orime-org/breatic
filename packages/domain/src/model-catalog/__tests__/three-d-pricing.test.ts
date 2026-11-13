// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Tripo H3.1 pricing contracts price every cell of WaveSpeed's price
 * table (inner#1691, design 2.4). `usd` is the table's figure before
 * `discount_rate`; the expected credits apply the discount the yaml states
 * and the deployment's credit multiplier, the way the charge does.
 *
 * Each run is given as the params `resolveParams` sends, except the case that
 * keeps `texture_quality` beside texture off: the formula has to branch on
 * `texture`, because the estimate fills a dropped param back from its default.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ceilToCreditCent } from "@breatic/shared";

import { estimateModelCredits, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

const T23D = "tripo-h3.1-t23d";
const I23D = "tripo-h3.1-i23d";
const MULTIVIEW = "tripo-h3.1-multiview";

/** The geometry every case starts from: standard, no low-poly, no parts. */
const GEOMETRY = { geometry_quality: "standard", smart_low_poly: false, generate_parts: false, export_uv: true, auto_size: false };
const NO_TEXTURE = { ...GEOMETRY, texture: false, pbr: false };
const { auto_size: _auto, ...GEOMETRY_ONLY } = NO_TEXTURE;

/**
 * A run with texture on at one quality.
 * @param quality - The texture quality.
 * @returns The params as resolved.
 */
function textured(quality: "standard" | "fast" | "detailed" | "extreme"): Record<string, unknown> {
  return {
    ...GEOMETRY,
    texture: true,
    pbr: true,
    texture_quality: quality,
    texture_version: quality === "fast" ? "v3.5" : "v3.0",
    ...(quality === "fast" ? { delight: true } : {}),
  };
}

interface PriceCase {
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The table's price for text-to-3D; the image entries cost $0.12 more. */
  readonly t23dUsd: number;
}

const CASES: readonly PriceCase[] = [
  { name: "geometry only", params: GEOMETRY_ONLY, t23dUsd: 0.12 },
  { name: "Standard texture", params: textured("standard"), t23dUsd: 0.24 },
  { name: "Fast texture", params: textured("fast"), t23dUsd: 0.24 },
  { name: "Detailed texture", params: textured("detailed"), t23dUsd: 0.36 },
  { name: "Extreme texture", params: textured("extreme"), t23dUsd: 0.48 },
  { name: "Standard texture with detailed geometry", params: { ...textured("standard"), geometry_quality: "detailed" }, t23dUsd: 0.48 },
  { name: "Standard texture with smart low-poly", params: { ...textured("standard"), smart_low_poly: true }, t23dUsd: 0.36 },
  { name: "parts, priced on geometry only", params: { ...GEOMETRY_ONLY, generate_parts: true }, t23dUsd: 0.36 },
  {
    name: "Extreme texture with detailed geometry and smart low-poly",
    params: { ...textured("extreme"), geometry_quality: "detailed", smart_low_poly: true },
    t23dUsd: 0.84,
  },
  { name: "texture off with Extreme quality still set", params: { ...GEOMETRY_ONLY, texture_quality: "extreme" }, t23dUsd: 0.12 },
];

/** What each entry's run carries besides its settings, and what it adds to the table's text-to-3D price. */
const ENTRIES: ReadonlyArray<{ model: string; sources: Record<string, unknown>; extraUsd: number }> = [
  { model: T23D, sources: {}, extraUsd: 0 },
  { model: I23D, sources: { image: "https://cdn.example.invalid/front.png" }, extraUsd: 0.12 },
  {
    model: MULTIVIEW,
    sources: { images: ["https://cdn.example.invalid/front.png", "https://cdn.example.invalid/left.png"] },
    extraUsd: 0.12,
  },
];

/**
 * The credits a table price comes to: WaveSpeed charges Tripo's table price in full.
 * @param usd - The table's price.
 * @returns The credits, rounded as the charge is.
 */
function creditsFor(usd: number): number {
  return ceilToCreditCent(usd * 100 * getModelCatalog().credit_multiplier);
}

beforeAll(useFullCatalog);
afterAll(restoreProcessEnv);

describe("Tripo H3.1 pricing", () => {
  for (const { model, sources, extraUsd } of ENTRIES) {
    for (const c of CASES) {
      it(`prices ${model}: ${c.name}`, async () => {
        const usd = Math.round((c.t23dUsd + extraUsd) * 100) / 100;
        expect(await estimateModelCredits(model, { params: { ...sources, ...c.params } })).toEqual({
          credits: expect.closeTo(creditsFor(usd), 6) as number,
          bound: "exact",
        });
      });
    }
  }

  it("prices text-to-3D at its defaults as Standard texture", async () => {
    expect(await estimateModelCredits(T23D, { params: {}, prompt: "a wooden chair" })).toEqual({
      credits: expect.closeTo(creditsFor(0.24), 6) as number,
      bound: "exact",
    });
  });
});
