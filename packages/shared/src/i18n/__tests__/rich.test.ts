// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";

import { resetLocales, setLocale, setLocaleMessages, tRich } from "@shared/i18n/index.js";

const strong = (chunks: string[]): string => `<strong>${chunks.join("")}</strong>`;

afterEach(() => {
  resetLocales();
  setLocale("en");
});

describe("tRich", () => {
  it("wraps tagged chunks with the handler and leaves params as given", () => {
    setLocaleMessages("en", { mail: { invite: "<b>{actor}</b> invited you" } });
    setLocale("en");
    expect(tRich("mail.invite", { actor: "a**b &amp;" }, { b: strong })).toBe(
      "<strong>a**b &amp;</strong> invited you",
    );
  });

  it("renders in the active locale and falls back to English for a missing key", () => {
    setLocaleMessages("en", { mail: { a: "<b>{n}</b> en", b: "only en" } });
    setLocaleMessages("ja", { mail: { a: "<b>{n}</b> ja" } });
    setLocale("ja");
    expect(tRich("mail.a", { n: "x" }, { b: strong })).toBe("<strong>x</strong> ja");
    expect(tRich("mail.b", {}, {})).toBe("only en");
  });

  it("formats ICU plural and select", () => {
    setLocaleMessages("en", {
      mail: { days: "{n, plural, one {# day} other {# days}}", role: "{r, select, editor {Editor} other {Viewer}}" },
    });
    setLocale("en");
    expect(tRich("mail.days", { n: 1 }, {})).toBe("1 day");
    expect(tRich("mail.days", { n: 7 }, {})).toBe("7 days");
    expect(tRich("mail.role", { r: "editor" }, {})).toBe("Editor");
  });

  it("returns the key when it is missing everywhere", () => {
    setLocaleMessages("en", {});
    setLocale("en");
    expect(tRich("mail.none", {}, {})).toBe("mail.none");
  });
});
