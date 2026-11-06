// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web app registers only English and the reader's own locale as full
 * catalogs (breatic#1374); the one key `tInEveryLocale` reads back in every
 * language reaches the engine through a separate every-locale table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAvailableLocales,
  resetLocales,
  setEveryLocaleMessages,
  setLocale,
  setLocaleMessages,
  tInEveryLocale,
} from "@shared/i18n/index.js";

const OTHERS = ["zh-CN", "zh-TW", "ja", "ko"] as const;

/**
 * Parse a shipped locale catalog from the repository root.
 * @param locale - Locale tag, the file's base name.
 * @returns The parsed catalog.
 */
function catalog(locale: string): Record<string, unknown> {
  const file = resolve(import.meta.dirname, `../../../../../locales/${locale}.json`);
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

/**
 * The reference wording a catalog holds.
 * @param messages - A parsed catalog.
 * @returns Its `canvas.promptMark.reference` message.
 */
function referenceOf(messages: Record<string, unknown>): string {
  return ((messages.canvas as Record<string, unknown>).promptMark as Record<string, string>).reference ?? "";
}

beforeEach(() => {
  resetLocales();
  setLocaleMessages("en", catalog("en"));
  for (const locale of OTHERS) {
    setEveryLocaleMessages(locale, { canvas: { promptMark: { reference: referenceOf(catalog(locale)) } } });
  }
});

afterEach(() => {
  resetLocales();
});

describe("every-locale messages", () => {
  it("formats the key in all five languages, the active one first, with only English as a full catalog", () => {
    setLocale("ja");
    const wordings = tInEveryLocale("canvas.promptMark.reference", { label: "X" });
    const expected = ["en", ...OTHERS].map((locale) => referenceOf(catalog(locale)).replace("{label}", "X"));
    expect(wordings[0]).toBe(referenceOf(catalog("ja")).replace("{label}", "X"));
    expect([...wordings].sort()).toEqual([...expected].sort());
  });

  it("does not count a locale known only through the every-locale table as available", () => {
    expect(getAvailableLocales()).toEqual(["en"]);
  });

  it("is cleared by resetLocales", () => {
    resetLocales();
    setLocaleMessages("en", catalog("en"));
    expect(tInEveryLocale("canvas.promptMark.reference", { label: "X" })).toEqual([
      referenceOf(catalog("en")).replace("{label}", "X"),
    ]);
  });
});
