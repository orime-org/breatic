// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * i18n loader tests — node-side adapter (`@breatic/core` loadLocales)
 * integrated with the shared engine (`@breatic/shared` t()).
 *
 * Moved here from `@breatic/shared` (2026-05-29): the node-only loader
 * (`node:fs` + `node:async_hooks`) relocated from `shared/i18n/load-node`
 * into `core/i18n/locale-loader` so `@breatic/shared` stays 100%
 * browser-safe. The engine itself still lives in shared — this test
 * exercises both layers together (load from disk → translate).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  t,
  setLocale,
  getLocale,
  getAvailableLocales,
  resetLocales,
} from "@breatic/shared";
import { loadLocales } from "../i18n/locale-loader.js";
import { resolve } from "node:path";

describe("i18n loader", () => {
  beforeAll(() => {
    resetLocales();
    loadLocales(resolve(import.meta.dirname, "../../../../locales"));
  });

  afterEach(() => {
    setLocale("en");
  });

  describe("locale discovery", () => {
    it("should discover 5 locales", () => {
      const locales = getAvailableLocales();
      expect(locales).toContain("en");
      expect(locales).toContain("zh-CN");
      expect(locales).toContain("zh-TW");
      expect(locales).toContain("ja");
      expect(locales).toContain("ko");
    });

    it("should default to en", () => {
      expect(getLocale()).toBe("en");
    });
  });

  describe("English", () => {
    it("should resolve a server key", () => {
      expect(t("server.auth.invalid_credentials")).toBe("Invalid email or password");
    });

    it("should resolve a UI key", () => {
      expect(t("editor.accept")).toBe("Accept");
    });

    it("should resolve a frontend workspace key", () => {
      expect(t("workspace.create_new_project")).toBe("Create new project");
    });

    it("should interpolate parameters", () => {
      const result = t("server.error.insufficient_credits", { required: 10, available: 5 });
      expect(result).toContain("10");
      expect(result).toContain("5");
    });

    it("should return the key for missing translations", () => {
      expect(t("nonexistent.key")).toBe("nonexistent.key");
    });
  });

  describe("locale switching", () => {
    it("should switch to zh-CN", () => {
      setLocale("zh-CN");
      expect(getLocale()).toBe("zh-CN");
      const result = t("server.auth.invalid_credentials");
      expect(result).not.toBe("server.auth.invalid_credentials"); // Should be translated
    });

    it("should switch to ja", () => {
      setLocale("ja");
      expect(getLocale()).toBe("ja");
      const result = t("server.auth.invalid_credentials");
      expect(result).not.toBe("server.auth.invalid_credentials");
    });

    it("should fall back to English for missing keys", () => {
      setLocale("zh-CN");
      // A key that exists in en but may not in zh-CN
      const result = t("server.email.welcome_subject");
      expect(result).toBeTruthy();
      expect(result).not.toBe("server.email.welcome_subject");
    });
  });

  describe("reset", () => {
    it("should reset to initial state", () => {
      setLocale("ja");
      resetLocales();
      expect(getLocale()).toBe("en");
      // After reset, t() will reload locales lazily
      loadLocales(resolve(import.meta.dirname, "../../../../locales"));
      expect(getAvailableLocales().length).toBe(5);
    });
  });

  describe("default locales dir (no-arg)", () => {
    // Regression: when the node i18n adapter moved shared → core
    // (2026-05-29), the hard-coded relative default path
    // ("../../../../locales") broke because core's bundled output
    // sits at a different directory depth than shared's did, so
    // `loadLocales()` with no arg loaded zero locales and t() fell
    // back to raw keys. The default now anchors on MONOREPO_ROOT.
    // This asserts the no-arg call (what server boot uses) works.
    it("loadLocales() with no argument discovers all 5 locales", () => {
      resetLocales();
      loadLocales();
      expect(getAvailableLocales().sort()).toEqual(
        ["en", "ja", "ko", "zh-CN", "zh-TW"].sort(),
      );
      // And a real key resolves (not the raw key fallback).
      expect(t("server.auth.invalid_credentials")).not.toBe(
        "server.auth.invalid_credentials",
      );
    });
  });
});
