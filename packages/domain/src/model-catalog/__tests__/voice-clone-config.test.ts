// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The voice cloning models, read off the real config.
 *
 * MiniMax Voice Clone is the one the panel opens on: the worker clones the
 * reference audio on its first use, keeps the id for that audio, and reads
 * the text in the cloned voice with MiniMax Speech 2.8 HD (design §9.5).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { getFullModelConfig, getModelCatalog, type FullModelEntry } from "@domain/model-catalog/model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(useFullCatalog);
afterAll(restoreProcessEnv);

/**
 * The tts bucket's entry for a model name.
 * @param name - Model id as the catalog spells it.
 * @returns The full config entry.
 * @throws {Error} When the catalog has no such tts model.
 */
function ttsEntry(name: string): FullModelEntry {
  const found = getFullModelConfig("tts").models.find((m) => m.name === name);
  if (!found) throw new Error(`no tts model named ${name}`);
  return found;
}

describe("MiniMax Voice Clone", () => {
  const clone = (): FullModelEntry => ttsEntry("minimax-voice-clone");

  it("declares the voice_clone mode and opens that mode", () => {
    expect(clone().mode).toBe("voice_clone");
    const first = getFullModelConfig("tts").models.find((m) => m.mode === "voice_clone");
    expect(first?.name).toBe("minimax-voice-clone");
  });

  it("takes the reference audio from a canvas slot", () => {
    expect(clone().params?.audio).toMatchObject({ fill: "canvas", accepts: "audio" });
    expect(clone().params?.audio?.optional).toBeUndefined();
  });

  it("clones for the speech model the catalog keeps", () => {
    expect(clone().params?.model).toMatchObject({ fill: "none", default: "speech-2.8-hd" });
  });

  it("leaves the voice id to the worker", () => {
    expect(clone().params?.custom_voice_id).toMatchObject({ fill: "none" });
  });

  it("names an icon, which the picker has no fallback for", () => {
    expect(clone().icon).toBe("minimax");
  });

  it("runs on WaveSpeed first", () => {
    expect(getModelCatalog().tts.find((m) => m.name === "minimax-voice-clone")?.availability.upstreams[0]?.upstream).toBe("wavespeed");
  });
});
