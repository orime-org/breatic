// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — the fields the audio panel reads off a tts model.
 *
 * `remote_source` names the picker that fills a param whose value domain lives
 * upstream, and a ranged param carries what a slider needs. Both travel yaml →
 * `projectModelEntry` → the wire, and that projection lists its fields one by
 * one: a field nobody adds a line for is simply absent, with nothing failing to
 * say so.
 *
 * These read the REAL config files. A fixture would prove the projection can
 * carry a field; only the real catalog proves the models actually declare one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { getFullModelConfig, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(() => {
  useFullCatalog();
});

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

describe("the voice param names itself to the panel (#1960 A2)", () => {
  // The two models spell the same choice differently, so the panel finds the
  // param by this marker rather than by name.
  it.each([
    ["elevenlabs-v3", "voice_id"],
    ["minimax-speech-2.8-hd", "voice_id"],
  ])("marks %s's %s as filled from the voice catalog", (model, param) => {
    expect(ttsEntry(model).params[param]?.remote_source).toBe("voices");
  });

  // At most one, never exactly one: a voice-cloning model takes a reference
  // recording the user picked on the canvas rather than a choice from a
  // catalog, so it marks none.
  // Two marks on one model is what has no answer — the panel would have no way
  // to say which param the picker writes.
  it("marks at most one param per tts model, so the panel has one answer", () => {
    for (const entry of getModelCatalog().tts) {
      const marked = Object.entries(entry.params).filter(
        ([, spec]) => spec.remote_source === "voices",
      );
      expect(marked.length).toBeLessThanOrEqual(1);
    }
  });

  it("leaves ordinary params unmarked", () => {
    expect(ttsEntry("minimax-speech-2.8-hd").params.speed?.remote_source).toBeUndefined();
  });
});

describe("the speaking params declare what a control needs (#1960 A15)", () => {
  // The panel builds its controls off these declarations alone: a list of
  // stops becomes options, a min/max/step triple becomes a slider, and a
  // declaration missing any of the three renders nothing at all while its
  // value still travels to the vendor. Pinned against the real yaml because
  // that silence is what a fixture copy cannot show.
  it.each([
    ["elevenlabs-v3", "stability"],
    ["elevenlabs-v3", "similarity"],
    ["minimax-speech-2.8-hd", "speed"],
    ["minimax-speech-2.8-hd", "volume"],
  ])("gives %s's %s a complete range", (model, param) => {
    const spec = ttsEntry(model).params[param];
    expect(typeof spec?.min).toBe("number");
    expect(typeof spec?.max).toBe("number");
    expect(typeof spec?.step).toBe("number");
  });

  // A param carrying both is a param whose control has two answers, and the
  // panel reads one of them.
  it("leaves a ranged param without a list of stops", () => {
    for (const entry of getModelCatalog().tts) {
      for (const [name, spec] of Object.entries(entry.params)) {
        if (typeof spec.min !== "number") continue;
        expect(spec.values, `${entry.name}.${name}`).toBeUndefined();
      }
    }
  });
});

describe("the ElevenLabs voices are the endpoint's presets (#2156 design 9.5)", () => {
  // WaveSpeed's two ElevenLabs endpoints name their voices by preset name:
  // elevenlabs/voice-changer takes exactly these as an enum, and
  // elevenlabs/eleven-v3 offers them as its suggestions
  // (wavespeed.ai/docs/docs-api/elevenlabs/elevenlabs-voice-id). An id outside
  // this list is refused by the changer, so both lists are held to it.
  const PRESETS = [
    "Adam", "Alice", "Alicia", "Aria", "Baxter", "Bella", "Bill", "Brian", "Caleb",
    "Callum", "Charlie", "Charlotte", "Chris", "Daniel", "Darian", "Eddie", "Elara",
    "Eldrin", "Elowen", "Eric", "Finley", "Florence", "George", "Harry", "Jade",
    "Jessica", "Kaelen", "Laura", "Lawrence", "Liam", "Lily", "Maisie", "Matilda",
    "River", "Roger", "Sarah", "Sawyer", "Talia", "Warren", "Will", "Wyatt",
  ];

  /**
   * Reads one model's yaml entry.
   * @param name - The model id.
   * @returns The entry.
   * @throws {Error} When the catalog carries no such tts model.
   */
  function yamlEntry(name: string): ReturnType<typeof getFullModelConfig>["models"][number] {
    const entry = getFullModelConfig("tts").models.find((m) => m.name === name);
    if (!entry) throw new Error(`no tts model named ${name}`);
    return entry;
  }

  it.each(["elevenlabs-v3", "elevenlabs-voice-changer"])(
    "lists every preset of %s, by name, each with a sample and nothing else",
    (model) => {
      const voices = yamlEntry(model).voices ?? [];
      expect(voices.map((v) => v.id).sort()).toEqual([...PRESETS].sort());
      for (const voice of voices) {
        expect(voice.name, voice.id).toBe(voice.id);
        expect(voice.sample_url, voice.id).toMatch(/^https:\/\/\S+$/);
      }
    },
  );

  it.each(["elevenlabs-v3", "elevenlabs-voice-changer"])(
    "defaults %s to the endpoint's own default voice",
    (model) => {
      expect(yamlEntry(model).params?.voice_id?.default).toBe("Alicia");
    },
  );

  // The endpoint's default; the design's table of our own defaults has no row
  // for it.
  it("defaults eleven-v3's similarity to the endpoint's 1", () => {
    expect(yamlEntry("elevenlabs-v3").params?.similarity?.default).toBe(1);
  });
});
