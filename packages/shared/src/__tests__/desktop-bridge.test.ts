// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scheme a desktop build receives its sign-in code on (#1599, design
 * §8.3). A website can register a handler only for `web+…` schemes and the
 * browsers' safelists, none of which has a dot, so a reverse domain name
 * (RFC 8252 §7.1) is one no website can claim. The server's deployment
 * setting and the brand a build is made for both pass through this one rule.
 */

import { describe, it, expect } from "vitest";

import { desktopSignInLink, isDesktopAppScheme } from "@shared/desktop-bridge.js";

describe("isDesktopAppScheme", () => {
  it.each(["ai.breatic.desktop", "com.acme.studio", "io.x-y.app2"])("accepts the reverse domain name %s", (scheme) => {
    expect(isDesktopAppScheme(scheme)).toBe(true);
  });

  it.each([
    "breatic",
    "web+breatic",
    "magnet",
    "ipfs",
    "dweb",
    "ethereum",
    "payto",
    "http",
    "https",
    "javascript",
    "Ai.Breatic.Desktop",
    "ai..breatic",
    ".ai.breatic",
    "ai.breatic.",
    "1ai.breatic",
    "ai.breatic desktop",
    "",
  ])("refuses %j, which a website could register or which is not a reverse domain name", (scheme) => {
    expect(isDesktopAppScheme(scheme)).toBe(false);
  });
});

describe("desktopSignInLink", () => {
  it("is the sign-in path under the build's own scheme", () => {
    expect(desktopSignInLink("ai.breatic.desktop")).toBe("ai.breatic.desktop://sign-in");
  });
});
