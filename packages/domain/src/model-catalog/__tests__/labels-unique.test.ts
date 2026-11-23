// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Every list that offers a modality's models together (the BYOK settings' "Models it runs" and model rows) names each
 * model apart: two models with one display name each carry a variant, so `modelLabel` can tell them apart.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelLabel } from "@breatic/shared";

import { getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("the catalog's labels within a modality", () => {
  it("name every model apart", () => {
    const catalog = getModelCatalog() as unknown as Record<string, unknown>;
    for (const [modality, list] of Object.entries(catalog)) {
      if (!Array.isArray(list)) continue;
      const labels = list.map((model) => modelLabel(model, list));
      const repeated = labels.filter((label, i) => labels.indexOf(label) !== i);
      expect(repeated, modality).toEqual([]);
    }
  });

  it("give every model that shares its display name a variant of its own", () => {
    const catalog = getModelCatalog() as unknown as Record<string, unknown>;
    for (const [modality, list] of Object.entries(catalog)) {
      if (!Array.isArray(list)) continue;
      const models = list as { name: string; display_name: string; variant?: string }[];
      // A bare name beside its labelled peers does not say which of them it is.
      const bare = models
        .filter((model) => model.variant === undefined && models.some((peer) => peer !== model && peer.display_name === model.display_name))
        .map((model) => model.name);
      expect(bare, modality).toEqual([]);
    }
  });
});
