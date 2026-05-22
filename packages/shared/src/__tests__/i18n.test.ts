/**
 * i18n tests — JSON-based translation lookup, parameter interpolation, locale switching.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { t, setLocale, getLocale, getAvailableLocales, resetLocales } from "../i18n/index.js";
import { loadLocales } from "../i18n/load-node.js";
import { resolve } from "node:path";

describe("i18n", () => {
  beforeAll(() => {
    resetLocales();
    loadLocales(resolve(import.meta.dirname, "../../../../locales"));
  });

  afterEach(() => {
    setLocale("en");
  });

  describe("locale discovery", () => {
    it("should discover 4 locales", () => {
      const locales = getAvailableLocales();
      expect(locales).toContain("en");
      expect(locales).toContain("zh-CN");
      expect(locales).toContain("zh-TW");
      expect(locales).toContain("ja");
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
      expect(getAvailableLocales().length).toBe(4);
    });
  });
});
