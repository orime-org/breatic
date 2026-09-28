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

  // The gateway schemas state these caps in the text field's description.
  it.each([
    ["realtime-tts-2", 2000],
    ["minimax-speech-2.8-hd", 10000],
  ])("gives %s the %i characters its upstream states", (model, cap) => {
    useFullCatalog();
    expect(ttsEntry(model).max_input_chars).toBe(cap);
  });

  // The Gemini schema states no cap. Absent is the honest answer, and the panel
  // reads absent as uncapped; a number invented here would refuse text the
  // upstream accepts.
  it("leaves gemini-3.1-flash-text-to-speech uncapped, because its upstream states no cap", () => {
    useFullCatalog();
    expect(ttsEntry("gemini-3.1-flash-text-to-speech").max_input_chars).toBeUndefined();
  });

  it("answers 5000 on a deployment with only the WaveSpeed key", () => {
    useEnvWithKeys(["WAVESPEED_API_KEY"]);
    expect(ttsEntry("elevenlabs-v3").max_input_chars).toBe(5000);
  });

  it("declares the cap in yaml, not somewhere on the way out", () => {
    useFullCatalog();
    const yaml = getFullModelConfig("tts").models.find(
      (m) => m.name === "elevenlabs-v3",
    );
    expect(yaml?.max_input_chars).toBe(5000);
  });
});
