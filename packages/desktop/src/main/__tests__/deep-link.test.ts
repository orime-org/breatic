// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * How sign-in links on the build's own scheme reach the client (inner#2041,
 * design §9.2). On Windows and Linux the link arrives in the arguments of a
 * launch, the first one or a second instance handed to the first. An AppImage
 * installs nothing, so the client writes its own desktop entry to register the
 * scheme, named after the brand so two brands never overwrite each other's.
 */

import { describe, it, expect } from "vitest";

import { appImageDesktopEntry, findDeepLink } from "@desktop/main/deep-link.js";

const SCHEME = "com.acme.studio";

describe("findDeepLink", () => {
  it("finds the link on the build's scheme among the launch arguments", () => {
    expect(findDeepLink(["/Applications/Acme Studio", "--flag", `${SCHEME}://sign-in?code=a&challenge=b`], SCHEME)).toBe(
      `${SCHEME}://sign-in?code=a&challenge=b`,
    );
  });

  it("ignores links on another brand's scheme", () => {
    expect(findDeepLink(["/usr/bin/acme", "ai.breatic.desktop://sign-in?code=a&challenge=b", "https://app.example.com"], SCHEME)).toBeNull();
  });
});

describe("appImageDesktopEntry", () => {
  it("registers the brand's scheme under the brand's name for the AppImage at its path", () => {
    const entry = appImageDesktopEntry("/home/ada/Apps/Acme.AppImage", { productName: "Acme Studio", scheme: SCHEME });
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain("Name=Acme Studio");
    expect(entry).toContain('Exec="/home/ada/Apps/Acme.AppImage" %U');
    expect(entry).toContain(`MimeType=x-scheme-handler/${SCHEME};`);
    expect(entry).toContain("NoDisplay=true");
  });

  it("escapes a path with quotes and backslashes", () => {
    expect(appImageDesktopEntry('/home/a"b\\c/Acme.AppImage', { productName: "Acme Studio", scheme: SCHEME })).toContain(
      'Exec="/home/a\\"b\\\\c/Acme.AppImage" %U',
    );
  });
});
