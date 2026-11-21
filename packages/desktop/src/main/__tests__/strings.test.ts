// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The client's words follow the operating system's language, English otherwise (#1599). */

import { describe, it, expect } from "vitest";

import { stringsFor } from "@desktop/main/strings.js";

describe("stringsFor", () => {
  it.each([
    ["zh-CN", "连接到 breatic"],
    ["zh-TW", "連線到 breatic"],
    ["zh-HK", "連線到 breatic"],
    ["ja", "breatic に接続"],
    ["ko-KR", "breatic에 연결"],
    ["en-US", "Connect to breatic"],
    ["fr-FR", "Connect to breatic"],
  ])("speaks %s", (locale, title) => {
    expect(stringsFor(locale).connect.title).toBe(title);
  });
});
