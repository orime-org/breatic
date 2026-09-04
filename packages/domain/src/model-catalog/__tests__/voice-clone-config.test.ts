// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The voice-cloning model, read off the real config (#1960 PR2).
 *
 * The mode and its source requirement were already in place before this slice;
 * what was missing is a model that serves it on an upstream we can read a
 * charge back from. f5-tts on fal returned `cost: 0` for every run, and the
 * dispatch layer skips the charge entirely when credits come to zero — so each
 * generation was ours to pay for.
 *
 * These read the config rather than a fixture: a rate written into the yaml
 * with the wrong scale, or a mode string that no mode option matches, both look
 * fine in isolation and only fail where the two meet.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";
import { computeSourcesByMode, violatesSourceRequirement } from "../source-requirement.js";

const CLONE_MODEL = "qwen3-tts-voice-clone";

beforeAll(() => {
  initCore(process.env);
});

/**
 * The tts bucket's entry for a model name.
 * @param name - Model id as the catalog spells it.
 * @returns The full config entry, or undefined when the catalog has none.
 */
function ttsEntry(name: string): Record<string, unknown> | undefined {
  const bucket = getFullModelConfig("tts") as {
    models?: Array<Record<string, unknown>>;
  };
  return bucket.models?.find((m) => m.name === name);
}

describe("qwen3 voice cloning is in the catalog", () => {
  it("declares the mode the panel and the source table both spell", () => {
    const entry = ttsEntry(CLONE_MODEL);
    expect(entry, `${CLONE_MODEL} missing from the tts bucket`).toBeTruthy();
    expect(entry!.mode).toBe("voice_clone");
  });

  it("bills by character, on the scale the voiceover models use", () => {
    // 5 US cents per 1000 characters, the vendor's published price. The
    // voiceover models state their own rates in the same shape, so all three
    // read off one ruler.
    expect(ttsEntry(CLONE_MODEL)!.rate).toEqual({
      credits: 5,
      per: 1000,
      unit: "characters",
    });
  });

  it("names an icon, which the picker has no fallback for", () => {
    expect(typeof ttsEntry(CLONE_MODEL)!.icon).toBe("string");
    expect((ttsEntry(CLONE_MODEL)!.icon as string).length).toBeGreaterThan(0);
  });

  it("leaves the reference audio out of its param table", () => {
    // The slot is the only source of that value. Declaring it here would put a
    // `null` in the params record, and the source gate reads a non-string as
    // "no source" — refusing every submit that had one picked.
    const params = ttsEntry(CLONE_MODEL)!.params as Record<string, unknown> | undefined;
    expect(params?.audio).toBeUndefined();
  });

  it("states no input cap, because the vendor publishes none", () => {
    expect(ttsEntry(CLONE_MODEL)!.max_input_chars).toBeUndefined();
  });

  it("runs on wavespeed, the upstream that answers what a call cost", () => {
    const providers = ttsEntry(CLONE_MODEL)!.providers as Array<{ name: string }>;
    expect(providers.map((p) => p.name)).toContain("wavespeed");
  });
});

describe("the source gate holds for cloning", () => {
  it("asks for an audio source", () => {
    expect(computeSourcesByMode("tts", "voice_clone")).toEqual({
      voice_clone: ["audio"],
    });
  });

  it("refuses a submit with no reference audio, and takes one that has it", () => {
    const sources = computeSourcesByMode("tts", "voice_clone");
    expect(violatesSourceRequirement(sources, { prompt: "x" })).toBe(true);
    expect(
      violatesSourceRequirement(sources, { prompt: "x", audio: "https://cdn/a.m4a" }),
    ).toBe(false);
  });
});

describe("f5-tts is gone", () => {
  it("no longer appears in the tts bucket", () => {
    expect(ttsEntry("f5-tts")).toBeUndefined();
  });
});
