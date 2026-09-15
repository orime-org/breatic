// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A model's guide is quoted to the reader whole (#261).
 *
 * The parameters beside it are filtered against what the panel offers; the
 * guide is not, so a sentence naming a slot the model cannot take reaches the
 * reader with nothing in the same answer to correct it. One entry promised
 * four reference images while declaring no image parameter at all, and the
 * mode it serves has no slot for one either.
 *
 * Only the phrases that name a slot are checkable this way. A guide claiming
 * something no parameter stands for -- a resolution, a number of speakers --
 * is for the copy pass and a reader to catch.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { ModelEntry } from "@breatic/shared";

import { getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/**
 * Phrases a guide uses for a slot, and the parameters that slot arrives in.
 *
 * Several per phrase, because one sentence covers more than one slot: the
 * image models call the style slot a reference image too, and an entry
 * declaring either of them can take what its guide promises.
 */
const PROMISED_SLOT: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/reference images?/i, ["images", "style_images"]],
  [/end frames?/i, ["end_image"]],
];

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("a model's guide", () => {
  it("names no slot the model cannot take", () => {
    useFullCatalog();
    const catalog = getModelCatalog();
    const broken: string[] = [];
    let read = 0;
    for (const bucket of Object.values(catalog)) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket as ModelEntry[]) {
        const guide = entry.guide ?? "";
        if (guide.length === 0) continue;
        read += 1;
        for (const [phrase, params] of PROMISED_SLOT) {
          if (!phrase.test(guide)) continue;
          if (params.some((param) => entry.params[param] !== undefined)) continue;
          broken.push(`${entry.name} promises ${params.join(" or ")}`);
        }
      }
    }
    expect(read, "the catalog writes some guides").toBeGreaterThan(0);
    expect(broken, "declare the parameter, or stop promising the slot").toEqual([]);
  });
});
