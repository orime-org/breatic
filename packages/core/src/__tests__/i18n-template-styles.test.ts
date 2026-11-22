// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The template style words (inner#1817) live in `locales/template-styles/`
 * and are merged into each locale the main catalogs register.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAvailableLocales, resetLocales, setLocale, t } from "@breatic/shared";
import { afterEach, describe, expect, it } from "vitest";

import { loadLocales } from "../i18n/locale-loader.js";

const dirs: string[] = [];

afterEach(() => {
  resetLocales();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A locales directory with its template-styles subdirectory.
 * @param main - Each locale's main catalog.
 * @param styles - Each locale's style catalog.
 * @returns The directory.
 */
function localesDir(main: Record<string, unknown>, styles: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "locales-"));
  dirs.push(dir);
  mkdirSync(join(dir, "template-styles"));
  for (const [locale, catalog] of Object.entries(main)) writeFileSync(join(dir, `${locale}.json`), JSON.stringify(catalog));
  for (const [locale, catalog] of Object.entries(styles)) writeFileSync(join(dir, "template-styles", `${locale}.json`), JSON.stringify(catalog));
  return dir;
}

describe("loadLocales with template styles", () => {
  it("merges each locale's style words into its main catalog", () => {
    loadLocales(
      localesDir(
        { en: { canvas: { template: { title: "Templates" } } } },
        { en: { canvas: { template: { styleSet: { s: { style: { a: { name: "Woodcut" } } } } } } } },
      ),
    );
    setLocale("en");
    expect(t("canvas.template.title")).toBe("Templates");
    expect(t("canvas.template.styleSet.s.style.a.name")).toBe("Woodcut");
  });

  it("registers no locale from a style catalog alone", () => {
    loadLocales(localesDir({ en: { a: "A" } }, { en: { b: "B" }, ja: { b: "ビー" } }));
    expect(getAvailableLocales()).toEqual(["en"]);
  });
});
