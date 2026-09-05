// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two music models, read off the real config (#1960).
 *
 * These read the config rather than a fixture because the failure they exist
 * to catch lives between two files: the worker builds its request from the
 * params a model DECLARES (`providers/shared.ts` drops anything else), so a
 * field the panel collects and the yaml does not name reaches the vendor as
 * nothing, and every browser-side test still passes.
 *
 * Every number here was measured against the WaveSpeed gateway on 2026-09-05
 * (`engineering/demo/2026-09-05-music-*.mjs` in the private repo), not read off
 * the vendor page.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig } from "@domain/model-catalog/model-catalog.js";
import { computeSourcesByMode } from "@domain/model-catalog/source-requirement.js";

beforeAll(() => {
  initCore(process.env);
});

/**
 * The audio bucket's entry for a model name.
 * @param name - Model id as the catalog spells it.
 * @returns The full config entry, or undefined when the catalog has none.
 */
function audioEntry(name: string): Record<string, unknown> | undefined {
  const bucket = getFullModelConfig("audio") as {
    models?: Array<Record<string, unknown>>;
  };
  return bucket.models?.find((m) => m.name === name);
}

describe("text to music: minimax-music-3.0", () => {
  const NAME = "minimax-music-3.0";

  it("serves the mode the panel spells", () => {
    const entry = audioEntry(NAME);
    expect(entry, `${NAME} missing from the audio bucket`).toBeTruthy();
    expect(entry?.mode).toBe("t2m");
  });

  it("declares the two params the panel offers", () => {
    const params = (audioEntry(NAME)?.params ?? {}) as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["is_instrumental", "lyrics"]);
  });

  it("bills what the gateway charges", () => {
    // $0.15 a call, at 1 credit = 1 US cent.
    expect(audioEntry(NAME)?.cost_per_call).toBe(15);
    expect(audioEntry(NAME)?.rate).toBeUndefined();
  });

  it("needs no source, so the panel can run it from a brief alone", () => {
    expect(computeSourcesByMode("audio", "t2m")).toEqual({ t2m: [] });
  });
});

describe("reference to music: minimax-music-01", () => {
  const NAME = "minimax-music-01";

  it("serves the mode the panel spells", () => {
    const entry = audioEntry(NAME);
    expect(entry, `${NAME} missing from the audio bucket`).toBeTruthy();
    expect(entry?.mode).toBe("a2m");
  });

  // The lyrics one is what this file exists for: the panel shows a lyrics box
  // on this mode, and an undeclared param is dropped by the worker before the
  // request is built. Measured 2026-09-05: the gateway takes `lyrics` here.
  it("declares its three references AND the lyrics the panel collects", () => {
    const params = (audioEntry(NAME)?.params ?? {}) as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual([
      "instrumental",
      "lyrics",
      "song",
      "voice",
    ]);
  });

  it("bills what the gateway charges", () => {
    // $0.35 a call. It was declared as 10 — cheaper than the model that costs
    // less than half as much.
    expect(audioEntry(NAME)?.cost_per_call).toBe(35);
    expect(audioEntry(NAME)?.rate).toBeUndefined();
  });

  it("needs an audio source, which is what the three slots collect", () => {
    expect(computeSourcesByMode("audio", "a2m")).toEqual({ a2m: ["audio"] });
  });
});

describe("both music models reach the gateway that was measured", () => {
  // The direct MiniMax transport builds prompt / lyrics / is_instrumental and
  // sends no reference URL at all, so a deployment holding MINIMAX_API_KEY
  // would have resolved music-01 to a connection that silently writes a song
  // unrelated to what the user picked, and bill for it.
  it("lists WaveSpeed and nothing else", () => {
    for (const name of ["minimax-music-3.0", "minimax-music-01"]) {
      const providers = (audioEntry(name)?.providers ?? []) as Array<{ name: string }>;
      expect(providers.map((p) => p.name), name).toEqual(["wavespeed"]);
    }
  });
});
