// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The client's words follow the operating system's language, English otherwise (#1599). */

import { describe, it, expect } from "vitest";

import { desktopText } from "@desktop/main/strings.js";

describe("desktopText", () => {
  it.each([
    ["zh-CN", "连接到 breatic"],
    ["zh-TW", "連線到 breatic"],
    ["zh-HK", "連線到 breatic"],
    ["ja", "breatic に接続"],
    ["ko-KR", "breatic에 연결"],
    ["en-US", "Connect to breatic"],
    ["fr-FR", "Connect to breatic"],
  ])("speaks %s", (locale, title) => {
    expect(desktopText(locale, "breatic")["desktop.connect.title"]).toBe(title);
  });

  it("has the same keys in every language", () => {
    const keys = Object.keys(desktopText("en", "breatic")).sort();
    for (const locale of ["zh-CN", "zh-TW", "ja", "ko"]) expect(Object.keys(desktopText(locale, "breatic")).sort()).toEqual(keys);
  });

  it("names the build's product wherever a text names the app", () => {
    const text = desktopText("en", "Acme Studio");
    expect(text["desktop.connect.title"]).toBe("Connect to Acme Studio");
    expect(text["desktop.connect.unreachableTitle"]).toBe("Can't reach Acme Studio");
    expect(text["desktop.errors.notServer"]).toBe("This address is not a Acme Studio server");
    for (const value of Object.values(text)) expect(value).not.toMatch(/breatic|\{product\}/);
  });
});
