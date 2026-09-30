// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a model needs reaches the wire from its declaration (#269, #2156).
 *
 * The panel asks `missingSources` of the entry it reads off the wire, and the
 * pre-enqueue gate asks it of the catalog, so the projection has to carry the
 * "one of these" groups exactly as the yaml declares them.
 */

import { beforeEach, afterAll, describe, it, expect } from "vitest";

import { MODALITIES, getFullModelConfig, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

describe("what the catalog ships about a model's sources", () => {
  beforeEach(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("carries every model's source groups as the yaml declares them", () => {
    const disagreeing: string[] = [];
    for (const modality of MODALITIES) {
      const declared = getFullModelConfig(modality).models;
      for (const entry of getModelCatalog()[modality]) {
        const yaml = declared.find((m) => m.name === entry.name)?.source_groups;
        if (JSON.stringify(entry.source_groups) !== JSON.stringify(yaml)) {
          disagreeing.push(`${modality}/${entry.name}`);
        }
      }
    }

    expect(disagreeing).toEqual([]);
  });

  it("ships the groups the reference modes declare", () => {
    const withGroups = MODALITIES.flatMap((modality) =>
      getModelCatalog()[modality]
        .filter((entry) => (entry.source_groups ?? []).length > 0)
        .map((entry) => entry.name),
    );

    expect(withGroups).toContain("wan-3.0-reference-to-video");
    expect(withGroups).toContain("mureka-v9.5-generate-song");
  });
});

describe("what the catalog keeps off the wire", () => {
  beforeEach(async () => {
    await useFullCatalog();
  });

  it("keeps the reason a param has no control on this side of it", () => {
    // `note` says why a declaration has no control, which is for whoever ships
    // the yaml. Every browser gets the catalog, and none of them reads it.
    const catalog = getModelCatalog();
    const withNote = MODALITIES.flatMap((modality) =>
      catalog[modality].flatMap((model) =>
        Object.entries(model.params)
          .filter(([, spec]) => "note" in spec)
          .map(([param]) => `${model.name}.${param}`),
      ),
    );

    expect(withNote).toEqual([]);
  });
});
