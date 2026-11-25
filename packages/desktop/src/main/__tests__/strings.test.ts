// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** The client's words follow the operating system's language, English otherwise (inner#2041). */

import { describe, it, expect } from "vitest";

import { desktopText } from "@desktop/main/strings.js";

describe("desktopText", () => {
  it.each([
    ["zh-CN", "连不上 breatic"],
    ["zh-TW", "連不上 breatic"],
    ["zh-HK", "連不上 breatic"],
    ["ja", "breatic に接続できません"],
    ["ko-KR", "breatic에 연결할 수 없습니다"],
    ["en-US", "Can't reach breatic"],
    ["fr-FR", "Can't reach breatic"],
  ])("speaks %s", (locale, title) => {
    expect(desktopText(locale, "breatic")["desktop.unreachable.title"]).toBe(title);
  });

  it("has the same keys in every language", () => {
    const keys = Object.keys(desktopText("en", "breatic")).sort();
    for (const locale of ["zh-CN", "zh-TW", "ja", "ko"]) expect(Object.keys(desktopText(locale, "breatic")).sort()).toEqual(keys);
  });

  it("names the build's product wherever a text names the app", () => {
    const text = desktopText("en", "Acme Studio");
    expect(text["desktop.unreachable.title"]).toBe("Can't reach Acme Studio");
    expect(text["desktop.updates.upToDate"]).toBe("Acme Studio is up to date");
    for (const value of Object.values(text)) expect(value).not.toMatch(/breatic|\{product\}/);
  });
});
