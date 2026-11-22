// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template style words live in their own catalogs (inner#1817) and are merged
 * into a locale that is already registered, never registering one themselves.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  getAvailableLocales,
  mergeLocaleMessages,
  resetLocales,
  setLocale,
  setLocaleMessages,
  t,
} from "@shared/i18n/index.js";

afterEach(() => {
  resetLocales();
});

describe("mergeLocaleMessages", () => {
  it("adds nested keys beside the ones already registered, keeping both", () => {
    setLocaleMessages("en", { canvas: { template: { title: "Templates" } } });
    mergeLocaleMessages("en", { canvas: { template: { styleSet: { s: { style: { a: { name: "Woodcut" } } } } } } });
    expect(t("canvas.template.title")).toBe("Templates");
    expect(t("canvas.template.styleSet.s.style.a.name")).toBe("Woodcut");
  });

  it("does nothing for a locale with no catalog yet, so it never stands in for one", () => {
    setLocaleMessages("en", { a: "A" });
    mergeLocaleMessages("ja", { a: "エー" });
    expect(getAvailableLocales()).toEqual(["en"]);
  });

  it("drops formatted messages cached for that locale", () => {
    setLocaleMessages("en", { greet: "Hi {name}" });
    setLocale("en");
    expect(t("greet", { name: "A" })).toBe("Hi A");
    mergeLocaleMessages("en", { greet: "Hello {name}" });
    expect(t("greet", { name: "A" })).toBe("Hello A");
  });
});
