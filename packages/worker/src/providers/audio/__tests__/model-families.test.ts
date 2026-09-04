// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every audio model the catalog declares has a family that can build its
 * request (#2088).
 *
 * `generateAsync` looks the family up by model name and throws when there is
 * none, so a model added to yaml without one is a task that fails at dispatch
 * — after the credits pre-check has passed and the user has watched it spin.
 * This reads the list the dispatcher's own map is built from: rebuilding it
 * here from the same imports would pass even with a family left unregistered,
 * which is the one case it exists to catch.
 */

import { describe, it, expect } from "vitest";

import { getFullModelConfig } from "@breatic/domain";

import { ALL_FAMILIES } from "@worker/providers/audio/index.js";
import sonilo from "@worker/providers/audio/models/sonilo.js";

describe("audio model families cover the catalog", () => {
  it("has a family for every model declared in config/models/audio", () => {
    const covered = new Set(ALL_FAMILIES.flatMap((f) => [...f.MODELS]));
    const declared = getFullModelConfig("audio").models.map((m) => m.name);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(covered.has(name), `no model family builds requests for ${name}`).toBe(true);
    }
  });

  it("claims each model exactly once, so the registry has no ambiguity", () => {
    const seen = new Set<string>();
    for (const family of ALL_FAMILIES) {
      for (const name of family.MODELS) {
        expect(seen.has(name), `${name} is claimed by two families`).toBe(false);
        seen.add(name);
      }
    }
  });
});

describe("the sonilo family hands its params through untouched (#2088)", () => {
  it("claims the sound-effect model", () => {
    expect(sonilo.MODELS.has("sonilo-sfx-v1")).toBe(true);
  });

  it("returns the params it was given, adding and dropping nothing", async () => {
    // The upstream reads `prompt`, `duration` and `audio_format` under exactly
    // those names, and the dispatcher assigns the prompt itself right after
    // this returns (`audio/index.ts:110`).
    const params = { duration: 5, audio_format: "mp3" };
    const [prompt, apiParams] = await sonilo.buildRequest(
      "glass shattering",
      "sonilo-sfx-v1",
      params,
    );
    expect(prompt).toBe("glass shattering");
    expect(apiParams).toEqual({ duration: 5, audio_format: "mp3" });
  });
});
