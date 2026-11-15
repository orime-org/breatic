// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1521: a run no upstream takes is explained in the user's language, naming the limit it broke when the refusal says
 * which, in one sentence the panels, the server and the worker all show.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inputRefusalText } from "@shared/input-refusal.js";
import { resetLocales, setLocale, setLocaleMessages } from "@shared/i18n/index.js";

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;

/**
 * One shipped catalog.
 * @param code - The locale.
 * @returns Its messages.
 */
const catalog = (code: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(__dirname, "../../../../locales", `${code}.json`), "utf8")) as Record<string, unknown>;

afterEach(() => {
  resetLocales();
  setLocale("en");
});

describe("inputRefusalText", () => {
  const model = "Gemini 3.8 Flash TTS";

  it("names the limit a count broke, of which field, whole, per line or per item", () => {
    setLocaleMessages("en", catalog("en"));
    setLocale("en");
    expect(inputRefusalText({ reason: "r", limit: { field: "prompt", measure: "characters", max: 8000 } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 8,000 characters in the text.");
    expect(inputRefusalText({ reason: "r", limit: { field: "prompt", measure: "characters", min: 3 } }, model))
      .toBe("Gemini 3.8 Flash TTS needs at least 3 characters in the text.");
    expect(inputRefusalText({ reason: "r", limit: { field: "prompt", measure: "characters", max: 8000, per: "line" } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 8,000 characters in each line of the text.");
    expect(inputRefusalText({ reason: "r", limit: { field: "multi_prompt", measure: "characters", max: 512, per: "item" } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 512 characters in each of the shot prompts.");
    expect(inputRefusalText({ reason: "r", limit: { field: "prompt", measure: "lines", max: 100 } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 100 lines in the text.");
    expect(inputRefusalText({ reason: "r", limit: { field: "negative_prompt", measure: "characters", max: 255 } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 255 characters in the negative prompt.");
    expect(inputRefusalText({ reason: "r", limit: { field: "lyrics", measure: "characters", max: 5000 } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 5,000 characters in the lyrics.");
    expect(inputRefusalText({ reason: "r", limit: { field: "prompt", measure: "chinese_characters", max: 2500 } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 2,500 Chinese characters in the text.");
  });

  it("gives a refusal no count explains, or a count of a kind it has no sentence for, the general sentence", () => {
    setLocaleMessages("en", catalog("en"));
    setLocale("en");
    const general = "Gemini 3.8 Flash TTS can’t take this run as set up. Change the settings or pick another model.";
    expect(inputRefusalText({ reason: "WaveSpeed refuses this" }, model)).toBe(general);
    expect(inputRefusalText({ param: "resolution", value: "4k" }, model)).toBe(general);
    expect(inputRefusalText({ reason: "r", limit: { field: "prompt", measure: "lines", min: 2 } }, model)).toBe(general);
  });

  it("calls a field it has no name for the text", () => {
    setLocaleMessages("en", catalog("en"));
    setLocale("en");
    expect(inputRefusalText({ reason: "r", limit: { field: "caption", measure: "characters", max: 10 } }, model))
      .toBe("Gemini 3.8 Flash TTS takes at most 10 characters in the text.");
  });

  it("has every sentence and field name in every shipped language", () => {
    for (const code of LOCALES) {
      resetLocales();
      setLocaleMessages(code, catalog(code));
      setLocale(code);
      for (const refusal of [
        { reason: "r", limit: { field: "prompt", measure: "characters", max: 1 } },
        { reason: "r", limit: { field: "negative_prompt", measure: "characters", min: 1 } },
        { reason: "r", limit: { field: "lyrics", measure: "characters", max: 1, per: "line" } },
        { reason: "r", limit: { field: "multi_prompt", measure: "characters", max: 1, per: "item" } },
        { reason: "r", limit: { field: "prompt", measure: "lines", max: 1 } },
        { reason: "r", limit: { field: "prompt", measure: "chinese_characters", max: 1 } },
        { reason: "r" },
      ] as const) {
        const text = inputRefusalText(refusal, model);
        expect(text, `${code}: ${JSON.stringify(refusal)}`).toContain(model);
        expect(text, `${code}: ${JSON.stringify(refusal)}`).not.toMatch(/server\.model/);
      }
    }
  });
});
