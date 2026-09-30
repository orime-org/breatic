// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * MiniMax Speech's pronunciation dictionary is a list of entries on our side
 * (the panel's list editor writes `{text, pronunciation}`) and a list of
 * `Alias/Pronunciation` strings upstream.
 */

import { describe, it, expect } from "vitest";

import minimaxSpeech from "@worker/providers/families/minimax-speech.js";

describe("minimax speech family", () => {
  it("covers the catalog's MiniMax Speech 2.8 HD", () => {
    expect([...minimaxSpeech.MODELS]).toEqual(["minimax-speech-2.8-hd"]);
    expect(minimaxSpeech.CONSUMES.has("pronunciation_dict")).toBe(true);
  });

  it("sends each entry as original/reading, in order", async () => {
    const { prompt, fields } = await minimaxSpeech.prepare("重庆的长江大桥。", {
      pronunciation_dict: [
        { text: "重庆", pronunciation: "chong2 qing4" },
        { text: "长江", pronunciation: "chang2 jiang1" },
      ],
    });

    expect(prompt).toBe("重庆的长江大桥。");
    expect(fields).toEqual({ pronunciation_dict: ["重庆/chong2 qing4", "长江/chang2 jiang1"] });
  });

  it("leaves out an entry missing either half, and sends no field when none is left", async () => {
    const half = await minimaxSpeech.prepare("x", {
      pronunciation_dict: [
        { text: "Omg", pronunciation: "" },
        { text: " ", pronunciation: "Oh my god" },
        { text: "Omg", pronunciation: "Oh my god" },
      ],
    });
    expect(half.fields).toEqual({ pronunciation_dict: ["Omg/Oh my god"] });

    expect((await minimaxSpeech.prepare("x", { pronunciation_dict: null })).fields).toEqual({});
    expect((await minimaxSpeech.prepare("x", { pronunciation_dict: [{ text: "a" }] })).fields).toEqual({});
  });
});
