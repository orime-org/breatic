// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { SCENARIO_TAGS, isScenarioTag } from "#rules/scenario-tags";

describe("the scenario tags", () => {
  it("names one tag per external service a case can need", () => {
    // The list is the contract between three places: the guard that rejects
    // a misspelt tag, the helper a spec imports, and the command that keeps
    // tagged cases out of the default selection. Declaring it once is what
    // stops those three from drifting.
    expect([...SCENARIO_TAGS].sort()).toEqual([
      "@needs-ffmpeg",
      "@needs-ingest",
      "@needs-internet",
      "@needs-model",
      "@needs-payments",
      "@needs-search",
      "@needs-storage",
      "@needs-tts",
    ]);
  });

  it("recognises a declared tag", () => {
    expect(isScenarioTag("@needs-model")).toBe(true);
  });

  it("rejects a tag nobody declared", () => {
    // A misspelt tag is worse than no tag: the case reads as guarded and
    // runs in the default selection anyway, because the exclusion pattern
    // never matches it.
    expect(isScenarioTag("@needs-modell")).toBe(false);
    expect(isScenarioTag("@needs-stripe")).toBe(false);
    expect(isScenarioTag("@smoke")).toBe(false);
  });
});
