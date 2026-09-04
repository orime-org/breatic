// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — the two fields the audio panel reads off a tts model.
 *
 * `rate` states what a model charges before the user generates; `remote_source`
 * names the picker that fills a param whose value domain lives upstream. Both
 * travel yaml → `projectModelEntry` → the wire, and that projection lists its
 * fields one by one: a field nobody adds a line for is simply absent, with
 * nothing failing to say so.
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

describe("tts rate reaches the wire (#1960 A5)", () => {
  // Both figures come from the vendors' own pricing pages, read 2026-09-01,
  // at 1 credit = 1 US cent on the zero-margin deduction rule.
  it("states elevenlabs-v3 at 10 credits per 1000 characters", () => {
    expect(ttsEntry("elevenlabs-v3").rate).toEqual({
      credits: 10,
      per: 1000,
      unit: "characters",
    });
  });

  // Fish bills per UTF-8 byte ($15.00 / M UTF-8 bytes), not per character —
  // a Chinese character is three of them, so the unit has to travel with the
  // number or the panel understates this model threefold.
  it("states fish-s2-pro at 1.5 credits per 1000 utf-8 bytes", () => {
    expect(ttsEntry("fish-s2-pro").rate).toEqual({
      credits: 1.5,
      per: 1000,
      unit: "utf8_bytes",
    });
  });

  it("declares the rate in yaml, not somewhere on the way out", () => {
    const yaml = getFullModelConfig("tts").models.find(
      (m) => m.name === "fish-s2-pro",
    );
    expect(yaml?.rate).toEqual({ credits: 1.5, per: 1000, unit: "utf8_bytes" });
  });
});

describe("the voice param names itself to the panel (#1960 A2)", () => {
  // The two models spell the same choice differently, so the panel finds the
  // param by this marker rather than by name.
  it.each([
    ["elevenlabs-v3", "voice_id"],
    ["fish-s2-pro", "reference_id"],
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
    expect(ttsEntry("fish-s2-pro").params.speed?.remote_source).toBeUndefined();
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
    ["fish-s2-pro", "speed"],
    ["fish-s2-pro", "volume"],
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

describe("the inline voice list carries a sample (#1960 A2)", () => {
  // These are the voices behind an aggregating gateway, which has no voice
  // endpoint to ask: the panel shows exactly what this file writes, so a
  // sample the file omits is a play button the user never gets. The upstream
  // publishes one per voice
  // (wavespeed.ai/docs/docs-api/elevenlabs/elevenlabs-voice-id).
  it("gives every elevenlabs-v3 voice a sample url", () => {
    const voices = getFullModelConfig("tts").models.find(
      (m) => m.name === "elevenlabs-v3",
    )?.voices;
    expect(voices?.length).toBeGreaterThan(0);
    for (const voice of voices ?? []) {
      expect(voice.sample_url, voice.id).toMatch(/^https:\/\/\S+\.mp3$/);
    }
  });
});
