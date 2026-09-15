// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which modes a generation node can actually be set to (#261).
 *
 * Two conditions, and the point of the tests is that BOTH are load-bearing:
 * the panel has to offer the mode, and the catalog has to back it right now.
 * Dropping either one reports a mode the user cannot select -- a mini-tool
 * mode that no picker lists, or a mode whose models are all unreachable.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  AUDIO_GENERATION_MODES,
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
} from "@breatic/shared";

import {
  getCanvasCapabilities,
  modelsForMode,
  usableModes,
  type CanvasCapabilities,
} from "../mode-catalog.js";
import { allProviderKeyNames, restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("usableModes", () => {
  it("reports a mode the panel offers and a model backs", () => {
    expect(usableModes(["t2i"], [{ mode: "t2i" }])).toEqual(["t2i"]);
  });

  it("drops a mode the panel offers that no model backs", () => {
    // The six image modes of #259 are exactly this shape: declared in
    // modes.yaml, zero models behind them.
    expect(usableModes(["t2i", "relight"], [{ mode: "t2i" }])).toEqual(["t2i"]);
  });

  it("drops a mode models back that the panel does not offer", () => {
    // `edit` / `upscale` / `remove_bg` have models and are mini-tool
    // operations: selecting one on a generation node is not something the
    // picker allows, and the backend source gate rejects the submit.
    expect(usableModes(["t2i"], [{ mode: "t2i" }, { mode: "upscale" }])).toEqual(["t2i"]);
  });

  it("counts every mode a multi-mode model declares", () => {
    expect(usableModes(["t2i", "i2i"], [{ mode: ["i2i", "edit"] }])).toEqual(["i2i"]);
  });

  it("keeps the panel's order rather than the catalog's", () => {
    expect(usableModes(["t2i", "i2i"], [{ mode: "i2i" }, { mode: "t2i" }])).toEqual([
      "t2i",
      "i2i",
    ]);
  });

  it("reports nothing when the catalog backs none of the panel's modes", () => {
    expect(usableModes(["t2i", "i2i"], [])).toEqual([]);
  });
});

describe("getCanvasCapabilities", () => {
  it("reports only modes the node's own picker offers", () => {
    const capabilities = withEveryProviderKey();
    expect(Object.keys(capabilities).length, "the catalog backs some node").toBeGreaterThan(
      0,
    );
    const offered: Record<string, readonly string[]> = {
      image: IMAGE_GENERATION_MODES,
      video: VIDEO_GENERATION_MODES,
      audio: AUDIO_GENERATION_MODES,
    };
    for (const [nodeType, modes] of Object.entries(capabilities)) {
      for (const mode of modes) {
        expect(offered[nodeType], `${nodeType} is a generation node`).toBeDefined();
        expect(
          offered[nodeType],
          `${nodeType} picker offers ${mode.mode}`,
        ).toContain(mode.mode);
      }
    }
  });

  it("gives every reported mode a label and a one-line description", () => {
    const capabilities = withEveryProviderKey();
    expect(Object.keys(capabilities).length, "the catalog backs some node").toBeGreaterThan(
      0,
    );
    for (const modes of Object.values(capabilities)) {
      for (const mode of modes) {
        expect(mode.label.length, `${mode.mode} label`).toBeGreaterThan(0);
        expect(mode.what.length, `${mode.mode} description`).toBeGreaterThan(0);
        expect(mode.what, `${mode.mode} description is one line`).not.toContain("\n");
      }
    }
  });

  it("draws the audio node from both the tts and audio catalog buckets", () => {
    const audio = withEveryProviderKey().audio ?? [];
    const reported = audio.map((mode) => mode.mode);
    // `tts` is declared in config/models/tts, `t2m` in config/models/audio;
    // one picker offers both, so one bucket alone cannot answer for the node.
    expect(reported).toContain("tts");
    expect(reported).toContain("t2m");
  });

  it("follows the catalog: a node whose models are all unreachable disappears", () => {
    useEnvWithKeys([]);
    expect(getCanvasCapabilities()).toEqual({});
  });

  it("follows the catalog: revoking one provider's key takes its models with it", () => {
    // A subset assertion against the full answer holds even for code that
    // ignores keys entirely -- measured: with only the first key configured
    // the answer is byte-identical to the all-keys one. So this subtracts a
    // key whose models nothing else backs, and names what has to disappear.
    const withoutFish = allProviderKeyNames().filter((name) => name !== "FISH_API_KEY");
    useEnvWithKeys(withoutFish);
    const answer = modelsForMode("audio", "tts");
    expect(answer.available, "other models still serve tts").toBe(true);
    if (!answer.available) return;
    expect(
      answer.models.map((model) => model.name),
      "fish-s2-pro is served by fish alone",
    ).not.toContain("fish-s2-pro");

    useEnvWithKeys(allProviderKeyNames());
    const withFish = modelsForMode("audio", "tts");
    expect(withFish.available && withFish.models.map((model) => model.name)).toContain(
      "fish-s2-pro",
    );
  });

  it("follows the catalog: a mode whose only models go, goes too", () => {
    const both = ["WAVESPEED_API_KEY"];
    useEnvWithKeys(allProviderKeyNames());
    expect(
      (getCanvasCapabilities().audio ?? []).map((mode) => mode.mode),
      "a2m is offered while its models are reachable",
    ).toContain("a2m");

    useEnvWithKeys(allProviderKeyNames().filter((name) => !both.includes(name)));
    expect(
      (getCanvasCapabilities().audio ?? []).map((mode) => mode.mode),
      "both music models are wavespeed-only",
    ).not.toContain("a2m");
  });
});

/**
 * The capabilities with every provider key configured.
 *
 * Unit runs carry no vendor keys, so a bare call reads an empty catalog and
 * every assertion that walks the answer passes over nothing.
 * @returns The full answer, measured with all keys present.
 */
function withEveryProviderKey(): CanvasCapabilities {
  useEnvWithKeys(allProviderKeyNames());
  return getCanvasCapabilities();
}
