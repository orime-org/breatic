// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A model whose style slot joins its image pool keeps three of the upstream's
 * images for style (inner#826). The pool's cap is what the reader can @, so
 * the cap plus the style slot's has to equal what the upstream takes, or a
 * full pool plus full style slot is refused upstream.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";
import { modelsForMode } from "../mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/** What each upstream takes in its image list, from its WaveSpeed contract. */
const UPSTREAM_TOTAL: Readonly<Record<string, number>> = {
  "gpt-image-2.5-sunburst-edit": 16,
  "nano-banana-pro-edit-ultra": 14,
  "muse-image-edit": 10,
};

describe("a style slot joining an image pool", () => {
  const joining = getFullModelConfig("image").models.filter(
    (m) => typeof m.params?.style_images?.joins === "string",
  );

  it("is declared on exactly the models whose upstream total is known", () => {
    expect(joining.map((m) => m.name).sort()).toEqual(Object.keys(UPSTREAM_TOTAL).sort());
  });

  it.each(Object.entries(UPSTREAM_TOTAL))("leaves %s's upstream total exactly filled", (name, total) => {
    const model = joining.find((m) => m.name === name);
    const pool = model?.params?.images?.max_items ?? 0;
    const style = model?.params?.style_images?.max_items ?? 0;
    expect(pool + style).toBe(total);
  });
});

// The Agent judges a proposal by what the mode table says each model takes,
// so the table has to carry the reserved split, not the upstream total.
describe("what the Agent reads for a joining model", () => {
  beforeAll(() => {
    useFullCatalog();
  });
  afterAll(() => {
    restoreProcessEnv();
  });

  it.each(Object.entries(UPSTREAM_TOTAL))("gives %s's pool the total minus three, and three style places", (name, total) => {
    const answer = modelsForMode("image", "i2i");
    if (!answer.available) throw new Error("i2i is not served");
    const model = answer.models.find((m) => m.name === name);
    expect(model?.params.images?.maxItems).toBe(total - 3);
    expect(model?.params.style_images?.maxItems).toBe(3);
  });
});
