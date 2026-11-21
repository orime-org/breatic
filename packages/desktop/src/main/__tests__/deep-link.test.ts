// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How `breatic://` links reach the client (#1599, design §9.2). On Windows
 * and Linux the link arrives in the arguments of a launch, the first one or a
 * second instance handed to the first. An AppImage installs nothing, so the
 * client writes its own desktop entry to register the scheme.
 */

import { describe, it, expect } from "vitest";

import { appImageDesktopEntry, findDeepLink } from "@desktop/main/deep-link.js";

describe("findDeepLink", () => {
  it("finds the link among the launch arguments", () => {
    expect(findDeepLink(["/Applications/breatic", "--flag", "breatic://sign-in?code=a&challenge=b"])).toBe("breatic://sign-in?code=a&challenge=b");
  });

  it("has nothing when no argument is a breatic link", () => {
    expect(findDeepLink(["/usr/bin/breatic", "https://breatic.ai"])).toBeNull();
  });
});

describe("appImageDesktopEntry", () => {
  it("registers the scheme for the AppImage at its path", () => {
    const entry = appImageDesktopEntry("/home/ada/Apps/breatic.AppImage");
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain('Exec="/home/ada/Apps/breatic.AppImage" %U');
    expect(entry).toContain("MimeType=x-scheme-handler/breatic;");
    expect(entry).toContain("NoDisplay=true");
  });

  it("escapes a path with quotes and backslashes", () => {
    expect(appImageDesktopEntry('/home/a"b\\c/breatic.AppImage')).toContain('Exec="/home/a\\"b\\\\c/breatic.AppImage" %U');
  });
});
