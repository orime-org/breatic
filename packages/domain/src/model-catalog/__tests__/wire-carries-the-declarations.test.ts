// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a mode needs reaches the wire from its declaration (#269).
 *
 * Two readers ask the question and neither can run the rule: the panel reads
 * `sourcesByMode[activeMode]` off the wire, and the pre-enqueue gate reads the
 * same field back off the catalog. So the catalog projection is where the
 * declaration turns into an answer, and this holds it to the yaml rather than
 * to the table the yaml replaced.
 *
 * `sourceRuleByMode` rides along because the count is not in the source types:
 * a2m needs one audio source and offers three slots to carry it, and only the
 * rule says one of them is enough.
 */

import { beforeEach, afterAll, describe, it, expect } from "vitest";

import { getModeConfig } from "../mode-config.js";
import { MODALITIES, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

describe("what the catalog ships about a mode", () => {
  beforeEach(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("is what the mode declares, for every model in every bucket", () => {
    const config = getModeConfig();
    const catalog = getModelCatalog();
    const disagreeing: string[] = [];

    for (const modality of MODALITIES) {
      for (const entry of catalog[modality]) {
        for (const mode of Array.isArray(entry.mode) ? entry.mode : [entry.mode]) {
          const declared = config[modality]?.modes[mode];
          const at = `${modality}/${entry.name}.${mode}`;
          if (entry.sourcesByMode[mode]?.join() !== (declared?.sources ?? []).join()) {
            disagreeing.push(`${at}: sources ${JSON.stringify(entry.sourcesByMode[mode])}`);
          }
          if (entry.sourceRuleByMode[mode] !== (declared?.sourceRule ?? "all_of")) {
            disagreeing.push(`${at}: rule ${String(entry.sourceRuleByMode[mode])}`);
          }
        }
      }
    }

    expect(disagreeing).toEqual([]);
  });

  it("says of a2m that any one of its slots is enough", () => {
    // The one mode whose panel refuses on an empty set rather than an empty
    // slot, so a rule that were uniformly all_of would read the same as none.
    const anyOf = MODALITIES.flatMap((modality) =>
      getModelCatalog()[modality].flatMap((entry) =>
        Object.entries(entry.sourceRuleByMode)
          .filter(([, rule]) => rule === "any_of")
          .map(([mode]) => `${modality}.${mode}`),
      ),
    );

    expect([...new Set(anyOf)]).toEqual(["audio.a2m"]);
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
