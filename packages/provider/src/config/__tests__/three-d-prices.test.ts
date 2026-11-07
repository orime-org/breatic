// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { priceUsd } from "../../pricing/evaluate.js";
import type { MediaBinding } from "../schema.js";
import { yaml } from "./shipped.js";

/** What WaveSpeed's `/model/price` charged for each sample run of a 3D model, as `pnpm provider:prices` read it. */
const PRICES = resolve(__dirname, "../../../test/fixtures/three-d-prices.json");
const charged = existsSync(PRICES) ? (JSON.parse(readFileSync(PRICES, "utf8")) as Record<string, { inputs: Record<string, unknown>; usd: number }[]>) : {};

const threeD = yaml<{ models: Record<string, { upstreams: MediaBinding[] }> }>("provider/media/three_d.yaml").models;
const bindings = Object.entries(threeD).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream === "wavespeed").map((binding) => ({ model, binding })));

describe("the 3D prices on WaveSpeed", () => {
  it("cover every 3D model WaveSpeed serves", () => {
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.filter(({ binding }) => (charged[binding.model_id] ?? []).length === 0).map(({ model }) => model)).toEqual([]);
  });

  it.each(bindings)("price each sample run of $model as WaveSpeed charged it", async ({ binding }) => {
    const { base_price, formula, discount_rate } = binding.pricing as { base_price: number; formula: string; discount_rate: number };
    for (const { inputs, usd } of charged[binding.model_id] ?? []) {
      expect(await priceUsd({ basePrice: base_price, formula, discountRate: discount_rate }, inputs, {}), JSON.stringify(inputs)).toBeCloseTo(usd, 9);
    }
  });
});
