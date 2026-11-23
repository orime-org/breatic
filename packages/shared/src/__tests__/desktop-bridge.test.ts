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

import { BASE64URL_32_BYTES, desktopSignInReturn, isDesktopAppScheme, parseDesktopSignInReturn } from "@shared/desktop-bridge.js";

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

describe("the sign-in return link", () => {
  const code = "c".repeat(43);
  const challenge = "d".repeat(43);

  it("is read back by the side that waits for it", () => {
    const link = desktopSignInReturn("com.acme.studio", code, challenge);
    expect(link.startsWith("com.acme.studio://sign-in?")).toBe(true);
    expect(parseDesktopSignInReturn(link, "com.acme.studio")).toEqual({ code, challenge });
  });

  it.each([
    ["another brand's scheme", desktopSignInReturn("ai.breatic.desktop", code, challenge)],
    ["another path", `com.acme.studio://other?code=${code}&challenge=${challenge}`],
    ["a short challenge", `com.acme.studio://sign-in?code=${code}&challenge=short`],
    ["no code", `com.acme.studio://sign-in?challenge=${challenge}`],
  ])("refuses %s", (_label, link) => {
    expect(parseDesktopSignInReturn(link, "com.acme.studio")).toBeNull();
  });

  it("matches 32 bytes in base64url without padding", () => {
    expect(BASE64URL_32_BYTES.test(code)).toBe(true);
    expect(BASE64URL_32_BYTES.test(`${code}=`)).toBe(false);
  });
});
