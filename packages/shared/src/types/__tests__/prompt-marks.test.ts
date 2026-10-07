// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three marks a prompt carries for the reader (inner#977): a reference
 * they @ by hand, words they fill in, and a note that is never sent. A
 * template's prompt lives in the locale files written with them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { setLocale, setLocaleMessages } from "@shared/i18n/index.js";
import { markText, markedSegments, promptPlainText, promptTextOf } from "@shared/types/canvas-proposal";

beforeAll(() => {
  for (const locale of ["en", "zh-CN"]) {
    const file = resolve(import.meta.dirname, `../../../../../locales/${locale}.json`);
    setLocaleMessages(locale, JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>);
  }
});

afterEach(() => {
  setLocale("en");
});

describe("markText", () => {
  it("asks the reader to @ a reference, in their language", () => {
    expect(markText({ kind: "asset", label: "character photo", note: "x" })).toBe("[📎 Use @ to pick character photo]");
    setLocale("zh-CN");
    expect(markText({ kind: "asset", label: "角色参考图", note: "x" })).toBe("[📎 请用 @ 选择 角色参考图]");
  });

  it("puts words to fill in between braces", () => {
    expect(markText({ kind: "tweak", label: "the story", note: "x" })).toBe("{✏️ the story}");
  });

  it("writes nothing into the text for a note, which never reaches the model", () => {
    expect(markText({ kind: "note", label: "Pick the first frame in the panel" })).toBe("");
  });
});

describe("markedSegments", () => {
  it("reads each mark as the place it stands for", () => {
    expect(markedSegments("(💡 Pick a frame) Use [📎 a photo] to show {✏️ the story}.")).toEqual([
      { slot: { kind: "note", label: "Pick a frame" } },
      { text: " Use " },
      { slot: { kind: "asset", label: "a photo", note: "a photo" } },
      { text: " to show " },
      { slot: { kind: "tweak", label: "the story", note: "the story" } },
      { text: "." },
    ]);
  });

  it("leaves words without marks as words, square-bracketed ones included", () => {
    expect(markedSegments("just words")).toEqual([{ text: "just words" }]);
    expect(markedSegments("[✏️ old style] (soft light)")).toEqual([{ text: "[✏️ old style] (soft light)" }]);
    expect(markedSegments("")).toEqual([]);
  });
});

describe("promptTextOf and promptPlainText", () => {
  it("measure the reference and fill-in marks and leave the note out", () => {
    const segments = markedSegments("(💡 Pick a frame)She walks in [📎 the photo]. {✏️ mood}");
    expect(promptTextOf(segments)).toBe("She walks in [📎 Use @ to pick the photo]. {✏️ mood}");
    expect(promptPlainText(segments)).toBe("She walks in [📎 Use @ to pick the photo]. {✏️ mood}");
  });
});
