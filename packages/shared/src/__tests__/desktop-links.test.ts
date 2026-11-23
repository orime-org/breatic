// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which addresses on our own server are pages of the app (inner#2041). The desktop
 * client keeps those in its window and hands every other page of the same
 * origin (the official site's terms, privacy and tutorials) to the system
 * browser.
 */

import { describe, it, expect } from "vitest";

import { ASSET_DOWNLOAD_PARAM, APP_ROUTE_PREFIXES, isAppPath } from "@shared/desktop-links.js";

describe("isAppPath", () => {
  it.each(["/studio", "/studio/ada", "/project/p1/space/s1", "/login", "/register", "/choose-slug", "/decision", "/desktop/sign-in"])(
    "keeps %s in the app",
    (path) => {
      expect(isAppPath(path)).toBe(true);
    },
  );

  it.each(["/", "/terms/", "/privacy/", "/tutorials/", "/studios", "/projects", "/loginx", "/desktopapp"])(
    "leaves %s to the site",
    (path) => {
      expect(isAppPath(path)).toBe(false);
    },
  );

  it("lists each prefix once, every one a path from the root", () => {
    expect(new Set(APP_ROUTE_PREFIXES).size).toBe(APP_ROUTE_PREFIXES.length);
    for (const prefix of APP_ROUTE_PREFIXES) expect(prefix).toMatch(/^\/[a-z-]+$/);
  });
});

describe("ASSET_DOWNLOAD_PARAM", () => {
  it("is the query the resource domain answers with an attachment", () => {
    expect(ASSET_DOWNLOAD_PARAM).toBe("download");
  });
});
