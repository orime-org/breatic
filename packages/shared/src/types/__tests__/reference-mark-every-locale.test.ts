// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A reference mark a collaborator wrote in another language is read back to
 * its bare label even when that language's full catalog was never downloaded
 * (breatic#1374): the web app registers English in full and the reference
 * wording of the other four through the every-locale table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetLocales, setEveryLocaleMessages, setLocale, setLocaleMessages } from "@shared/i18n/index.js";
import { markedSegments } from "@shared/types/canvas-proposal";

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

/** The every-locale key under test, held in a const so the dotted key can be a computed property. */
const REFERENCE_KEY = "canvas.promptMark.reference";

beforeEach(() => {
  resetLocales();
  setLocaleMessages("en", catalog("en"));
  for (const locale of ["zh-CN", "zh-TW", "ja", "ko"]) {
    setEveryLocaleMessages(locale, { [REFERENCE_KEY]: referenceOf(catalog(locale)) });
  }
  setLocale("en");
});

afterEach(() => {
  resetLocales();
});

describe("a reference mark written in a language not downloaded", () => {
  it("gives the bare label of a Japanese-worded mark to an English reader", () => {
    // Japanese label: the mark was written by a Japanese-speaking collaborator.
    const label = "キャラクター写真";
    const written = `[📎 ${referenceOf(catalog("ja")).replace("{label}", label)}]`;
    expect(markedSegments(written)).toEqual([{ slot: { kind: "asset", label, note: label } }]);
  });
});
