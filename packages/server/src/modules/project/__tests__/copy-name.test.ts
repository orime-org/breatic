// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A copy's name must hold four things at once, in every locale and for any
 * legal source name: it fits the project name limit, it starts with the copy
 * mark, it never ends inside a character the reader sees as one, and it
 * has no whitespace at either end (every rename entry trims, so a name with
 * one would be rewritten the moment someone opened it).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { loadLocales, runWithLocale } from "@breatic/core";
import { PROJECT_NAME_MAX_CHARS, t } from "@breatic/shared";

import { copyName } from "@server/modules/project/copy-name.js";

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"];

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Every length at which the source can be cut without splitting a character.
 * @param source - The source name
 * @returns The cut points, 0 and the full length included
 */
function boundaries(source: string): number[] {
  const cuts = [0];
  for (const { index, segment } of graphemes.segment(source)) cuts.push(index + segment.length);
  return cuts;
}

const SOURCES: Record<string, string> = {
  short: "Alley",
  "at the limit": "a".repeat(PROJECT_NAME_MAX_CHARS),
  "a space where the cut falls": `${"a".repeat(246)} ${"b".repeat(8)}`,
  "a flag where the cut falls": `${"x".repeat(245)}🇨🇳${"y".repeat(9)}`,
  "a joined emoji where the cut falls": `${"x".repeat(244)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}${"y".repeat(5)}`,
  "a letter with a combining mark at the cut": `${"x".repeat(246)}é${"y".repeat(7)}`,
  "emoji throughout": "😀".repeat(127),
  "CJK throughout": "名".repeat(PROJECT_NAME_MAX_CHARS),
  "one character longer than the room left": `a${"\u0301".repeat(PROJECT_NAME_MAX_CHARS - 1)}`,
  "only whitespace": "   ",
};

beforeAll(() => {
  loadLocales();
});

describe("copyName", () => {
  for (const locale of LOCALES) {
    for (const [label, source] of Object.entries(SOURCES)) {
      it(`${locale}: ${label}`, () => {
        runWithLocale(locale, () => {
          const mark = t("server.project.copy_name", { name: "" }).trim();
          const name = copyName(source);
          expect(name.length).toBeLessThanOrEqual(PROJECT_NAME_MAX_CHARS);
          expect(name.startsWith(mark)).toBe(true);
          expect(name).toBe(name.trim());
          expect(
            boundaries(source).some(
              (cut) =>
                t("server.project.copy_name", { name: source.slice(0, cut) }).trim() === name,
            ),
          ).toBe(true);
        });
      });
    }
  }

  it("keeps a short name whole", () => {
    runWithLocale("en", () => expect(copyName("Alley")).toBe("Copy of Alley"));
  });
});
