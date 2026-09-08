// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the MiniMax music family sends upstream (#1960).
 *
 * The browser half of this contract was pinned from the start
 * (`audio-task-payload.test.ts`); this half was not, which is why a param the
 * panel collects could be dropped between the two without anything failing.
 *
 * The numbers below are measurements against the WaveSpeed gateway on
 * 2026-09-05, not readings off the vendor page:
 * - `lyrics: ""` on music-3.0 -> refused, "invalid params, lyrics is required"
 * - `lyrics: "la"` (two characters) -> ACCEPTED, generation completed
 * - `lyrics: ""` with `is_instrumental: true` -> ACCEPTED, completed
 * The page's "10-3000 characters" is not what this gateway enforces.
 */

import { describe, it, expect } from "vitest";

import { buildRequest, MODELS } from "@worker/providers/audio/models/minimax.js";

describe("the MiniMax music family", () => {
  it("serves the two models the catalog names", () => {
    expect([...MODELS].sort()).toEqual(["minimax-music-01", "minimax-music-3.0"]);
  });

  it("passes the lyrics through as written", async () => {
    const [, params] = await buildRequest("warm indie folk", "minimax-music-3.0", {
      lyrics: "[Verse]\nMorning light across the kitchen floor",
      is_instrumental: false,
    });
    expect(params.lyrics).toBe("[Verse]\nMorning light across the kitchen floor");
  });

  // The gateway takes two characters. Substituting the style brief there would
  // put the user's own "warm indie folk, 90 BPM" into the song as words to sing.
  it("leaves a short lyric alone rather than singing the style brief", async () => {
    const [, params] = await buildRequest("warm indie folk, 90 BPM", "minimax-music-3.0", {
      lyrics: "la",
    });
    expect(params.lyrics).toBe("la");
  });

  it("leaves an empty lyrics empty on an instrumental run", async () => {
    const [, params] = await buildRequest("warm indie folk", "minimax-music-3.0", {
      lyrics: "",
      is_instrumental: true,
    });
    expect(params.lyrics).toBe("");
  });

  it("carries the three reference URLs through untouched", async () => {
    const [, params] = await buildRequest("same mood, slower", "minimax-music-01", {
      song: "https://cdn/song.mp3",
      voice: "https://cdn/voice.mp3",
      instrumental: "https://cdn/backing.mp3",
      lyrics: "[Verse]\nwords",
    });
    expect(params).toEqual({
      song: "https://cdn/song.mp3",
      voice: "https://cdn/voice.mp3",
      instrumental: "https://cdn/backing.mp3",
      lyrics: "[Verse]\nwords",
    });
  });

  it("hands the prompt back for the transport to send as its own argument", async () => {
    const [prompt] = await buildRequest("aggressive industrial metal", "minimax-music-01", {});
    expect(prompt).toBe("aggressive industrial metal");
  });
});
