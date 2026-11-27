// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The fixed text look every Timeline text clip uses, and the font-set files the preview reads (inner#1709 design §2.3,
 * §5.3). The preview and the export take the families and style from here; `faces.json` and `glyphs.json` are read
 * through these schemas by web and by the font script's tests.
 */

import { describe, expect, it } from "vitest";

import {
  TIMELINE_TEXT_FONT_FAMILIES, TIMELINE_TEXT_STYLE, TimelineFontFacesSchema, TimelineFontGlyphsSchema,
  timelineFontFilesMatch,
} from "../text.js";

const faces = [
  { family: "Inter", file: "inter-latin-wght-normal", unicodeRange: "U+0000-00FF,U+0131", weight: "100 900" },
  { family: "Inter", file: "inter-vietnamese-wght-normal", unicodeRange: "U+0102-0103,U+0110-0111" },
  { family: "Noto Sans SC", file: "noto-sans-sc-98-wght-normal", unicodeRange: "U+0000-00FF", weight: "100 900" },
];
const glyphs = [
  { file: "inter-latin-wght-normal", glyphRange: "U+0020-007E,U+00A0-00FF" },
  { file: "inter-vietnamese-wght-normal", glyphRange: "U+0102-0103" },
];

describe("TIMELINE_TEXT_FONT_FAMILIES (design §2.3)", () => {
  it("lists Inter, then SC, TC, JP and KR, the order of the page's own font stack", () => {
    expect([...TIMELINE_TEXT_FONT_FAMILIES]).toEqual(["Inter", "Noto Sans SC", "Noto Sans TC", "Noto Sans JP", "Noto Sans KR"]);
  });
});

describe("TIMELINE_TEXT_STYLE (design §2.3)", () => {
  it("is the demo's white, 600-weight, 1.2-line, shadowed, centred, pre-wrapped text", () => {
    expect(TIMELINE_TEXT_STYLE).toEqual({
      color: "#ffffff",
      fontWeight: 600,
      lineHeight: 1.2,
      textShadow: "0 1px 3px rgba(0,0,0,0.6)",
      textAlign: "center",
      whiteSpace: "pre-wrap",
    });
  });
});

describe("faces.json (design §5.3)", () => {
  it("accepts faces with and without a weight", () => {
    expect(TimelineFontFacesSchema.parse(faces)).toEqual(faces);
  });

  it.each([
    ["a face without a family", { file: "a", unicodeRange: "U+0041" }],
    ["a face without a file", { family: "Inter", unicodeRange: "U+0041" }],
    ["a face without a unicodeRange", { family: "Inter", file: "a" }],
    ["a face with an empty file", { family: "Inter", file: "", unicodeRange: "U+0041" }],
  ])("refuses %s", (_case, face) => {
    expect(TimelineFontFacesSchema.safeParse(faces).success).toBe(true);
    expect(TimelineFontFacesSchema.safeParse([...faces, face]).success).toBe(false);
  });
});

describe("glyphs.json (design §5.3)", () => {
  it("accepts entries of file and glyphRange", () => {
    expect(TimelineFontGlyphsSchema.parse(glyphs)).toEqual(glyphs);
  });

  it.each([
    ["an empty glyphRange, which the script leaves out instead", { file: "inter-latin-ext-wght-normal", glyphRange: "" }],
    ["an entry without a glyphRange", { file: "inter-latin-ext-wght-normal" }],
    ["an entry without a file", { glyphRange: "U+0041" }],
  ])("refuses %s", (_case, entry) => {
    expect(TimelineFontGlyphsSchema.safeParse(glyphs).success).toBe(true);
    expect(TimelineFontGlyphsSchema.safeParse([...glyphs, entry]).success).toBe(false);
  });
});

describe("timelineFontFilesMatch (design §5.3, §7.6)", () => {
  it("accepts glyph entries that each name a distinct face file, faces left out included", () => {
    expect(timelineFontFilesMatch(faces, glyphs)).toBe(true);
  });

  it("refuses a glyph entry naming a file faces.json does not hold", () => {
    expect(timelineFontFilesMatch(faces, [...glyphs, { file: "noto-sans-kr-0-wght-normal", glyphRange: "U+AC00" }])).toBe(false);
  });

  it("refuses two glyph entries naming the same file", () => {
    expect(timelineFontFilesMatch(faces, [...glyphs, { file: "inter-latin-wght-normal", glyphRange: "U+0041" }])).toBe(false);
  });
});
