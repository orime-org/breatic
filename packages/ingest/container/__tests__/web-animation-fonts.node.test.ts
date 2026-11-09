// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The font set `scripts/web-animation-fonts.mjs` lays out is the one the runner embeds and the check accepts, so
 * text in each product locale must find its glyphs in it; a glyph missing from the set falls back to a system font
 * and the package check refuses it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WEB_ANIMATION_FONT_FAMILIES } from "../web-animation-package.js";

interface Face {
  family: string;
  unicodeRange: string;
}

const SCRIPT = resolve(__dirname, "../../scripts/web-animation-fonts.mjs");
let out = "";
let faces: Face[] = [];

/**
 * Whether one CSS unicode-range value covers a code point.
 * @param range - A comma-separated unicode-range value.
 * @param codePoint - The code point.
 * @returns Whether some part of the range holds it.
 */
function rangeCovers(range: string, codePoint: number): boolean {
  return range.split(",").some((part) => {
    const body = part.trim().replace(/^U\+/i, "");
    const [low, high] = body.includes("-")
      ? body.split("-").map((hex) => Number.parseInt(hex, 16))
      : [Number.parseInt(body.replace(/\?/g, "0"), 16), Number.parseInt(body.replace(/\?/g, "F"), 16)];
    return codePoint >= low! && codePoint <= high!;
  });
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "web-animation-fonts-"));
  execFileSync(process.execPath, [SCRIPT, out]);
  const [version] = readdirSync(out);
  faces = JSON.parse(readFileSync(join(out, version!, "faces.json"), "utf8")) as Face[];
});

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("the laid-out font set", () => {
  it("lays out faces of exactly the families the check accepts", () => {
    expect([...new Set(faces.map((face) => face.family))].sort()).toEqual([...WEB_ANIMATION_FONT_FAMILIES].sort());
  });

  it.each(["안녕하세요 반갑습니다", "제품 소개 영상"])("covers every Hangul syllable of %s", (text) => {
    const missing = [...text.replace(/\s/g, "")].filter(
      (char) => !faces.some((face) => rangeCovers(face.unicodeRange, char.codePointAt(0)!)),
    );
    expect(missing).toEqual([]);
  });

  it.each(["進捗管理 元気溌剌 蝋燭 鰯", "日本語の製品紹介動画"])("covers every Japanese character of %s", (text) => {
    const missing = [...text.replace(/\s/g, "")].filter(
      (char) => !faces.some((face) => rangeCovers(face.unicodeRange, char.codePointAt(0)!)),
    );
    expect(missing).toEqual([]);
  });

  it.each(["女媧 老嫗 慍怒 憤懣 臺灣", "產品介紹影片"])("covers every Traditional Chinese character of %s", (text) => {
    const missing = [...text.replace(/\s/g, "")].filter(
      (char) => !faces.some((face) => rangeCovers(face.unicodeRange, char.codePointAt(0)!)),
    );
    expect(missing).toEqual([]);
  });
});
