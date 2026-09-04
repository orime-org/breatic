// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — how much text a model will take.
 *
 * The cap is the model vendor's, and a gateway reselling that model cannot
 * raise it: it forwards the same request to the same API. So the number is
 * declared once on the model and does not move when a deployment switches
 * which provider carries it.
 *
 * These read the REAL config files, and drive provider resolution by switching
 * which keys are configured. A fixture would only prove the projection can
 * carry a number; nothing short of the real catalog proves the models declare
 * one.
 */

import { describe, it, expect, afterAll } from "vitest";

import { getFullModelConfig, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useEnvWithKeys, useFullCatalog } from "./catalog-env.js";

afterAll(() => {
  restoreProcessEnv();
});

/**
 * Finds a wire entry in the tts bucket.
 * @param name - The model id.
 * @returns That model's wire entry.
 * @throws {Error} When the catalog carries no such tts model.
 */
function ttsEntry(name: string): ReturnType<typeof getModelCatalog>["tts"][number] {
  const found = getModelCatalog().tts.find((m) => m.name === name);
  if (!found) throw new Error(`no tts model named ${name} in the catalog`);
  return found;
}

describe("a tts model states how much text it takes (#1960 A17)", () => {
  it("gives elevenlabs-v3 the vendor's 5000 characters", () => {
    // elevenlabs.io/docs/models, per-model character-limit table.
    useFullCatalog();
    expect(ttsEntry("elevenlabs-v3").max_input_chars).toBe(5000);
  });

  // Fish publishes no hard cap — its OpenAPI schema states no maxLength and it
  // describes usage as a fair-use policy. Absent is the honest answer, and the
  // panel reads absent as uncapped; a number invented here would refuse text
  // the vendor accepts.
  it("leaves fish-s2-pro uncapped, because its upstream states no cap", () => {
    useFullCatalog();
    expect(ttsEntry("fish-s2-pro").max_input_chars).toBeUndefined();
  });

  // elevenlabs-v3 is carried by two providers, and which one answers is decided
  // by which key this deployment set. The cap must not move with that choice: a
  // reseller forwards the request to the same vendor API and cannot raise the
  // vendor's own limit, so a per-provider number would let one deployment offer
  // room the generation does not have.
  it.each([["ELEVENLABS_API_KEY"], ["WAVESPEED_API_KEY"]])(
    "answers 5000 whichever provider %s selects",
    (key) => {
      useEnvWithKeys([key]);
      expect(ttsEntry("elevenlabs-v3").max_input_chars).toBe(5000);
    },
  );

  it("declares the cap in yaml, not somewhere on the way out", () => {
    useFullCatalog();
    const yaml = getFullModelConfig("tts").models.find(
      (m) => m.name === "elevenlabs-v3",
    );
    expect(yaml?.max_input_chars).toBe(5000);
  });
});
