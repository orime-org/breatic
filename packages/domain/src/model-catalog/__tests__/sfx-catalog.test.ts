// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the sound-effect slice declares in the catalog (#1960 PR3 / #2088).
 *
 * Every figure here was measured against the gateway on 2026-09-04 and the
 * probes are kept in the private repo. The ones that would fail silently if
 * they drifted are the reason this file exists: a duration the gateway refuses
 * comes back as a 400 the user reads as "generation failed".
 *
 * These read the REAL config files, as the sibling catalog tests do.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  getFullModelConfig,
  getModelCatalog,
} from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * Finds a wire entry in the audio bucket.
 * @param name - The model id.
 * @returns That model's wire entry.
 * @throws {Error} When the catalog carries no such audio model.
 */
function audioEntry(name: string): ReturnType<typeof getModelCatalog>["audio"][number] {
  const found = getModelCatalog().audio.find((m) => m.name === name);
  if (!found) throw new Error(`no audio model named ${name} in the catalog`);
  return found;
}

describe("the sound-effect model reaches the wire (#2088 A2)", () => {
  it("carries sonilo-sfx-v1 under the sfx mode", () => {
    expect(audioEntry("sonilo-sfx-v1").mode).toBe("sfx");
  });

  it("routes it through WaveSpeed, the upstream whose spend we can read back", () => {
    expect(audioEntry("sonilo-sfx-v1").providers.map((p) => p.name)).toEqual([
      "wavespeed",
    ]);
  });

  // The exact string, not merely a truthy one: `ModelIcon` renders nothing
  // for a name its mark table does not hold, so a typo here shows the model
  // with no mark at all and nothing else reports it.
  it("names the icon the mark registry keys on", () => {
    expect(audioEntry("sonilo-sfx-v1").icon).toBe("sonilo");
  });
});

describe("its duration matches what the gateway enforces (#2088 A4 A8)", () => {
  // Probed 2026-09-04: the gateway answers 400 to a missing duration, to 0
  // ("must be at least 1"), to 181 ("must be at most 180") and to 2.5 ("must
  // be an integer"). Every preset therefore has to be an integer in 1..180.
  const PRESETS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180];

  it("offers the ten presets, ascending", () => {
    expect(audioEntry("sonilo-sfx-v1").params.duration?.values).toEqual(PRESETS);
  });

  it("keeps every preset the catalog declares inside the range the gateway accepts", () => {
    const declared = audioEntry("sonilo-sfx-v1").params.duration?.values ?? [];
    expect(declared.length).toBeGreaterThan(0);
    for (const preset of declared) {
      expect(typeof preset).toBe("number");
      expect(Number.isInteger(preset)).toBe(true);
      expect(preset as number).toBeGreaterThanOrEqual(1);
      expect(preset as number).toBeLessThanOrEqual(180);
    }
  });

  it("defaults to one of the presets, so the panel opens on a reachable stop", () => {
    const { values, default: fallback } = audioEntry("sonilo-sfx-v1").params.duration ?? {};
    expect(values).toContain(fallback);
  });
});

describe("its output format is pinned (#2088 A8)", () => {
  // Probed 2026-09-04: omitting audio_format returns aac, while
  // `dispatch.ts` stores every audio artefact under a `.mp3` extension.
  it("declares mp3, which is the extension the artefact is stored under", () => {
    expect(audioEntry("sonilo-sfx-v1").params.audio_format?.default).toBe("mp3");
  });
});
