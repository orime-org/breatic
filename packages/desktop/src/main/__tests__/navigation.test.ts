// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the desktop client does with a page that navigates or opens a window
 * (#1599, design §7).
 *
 * The app's own pages stay in the client; links elsewhere go to the system
 * browser, as do the official site's own pages (same origin, not the app).
 * Stripe checkout runs in the window, so paying returns to the signed-in
 * client, and a payment method that leaves Stripe stays until it comes back.
 * Asset downloads land in the client's save dialog.
 */

import { describe, it, expect } from "vitest";

import { decideNavigation, decideWindowOpen, isServerLoadFailure } from "@desktop/main/navigation.js";

const SERVER = "https://breatic.ai";

describe("decideNavigation", () => {
  it.each([
    ["an app page", "https://breatic.ai/studio/ada", "https://breatic.ai/login", "allow"],
    ["the sign-in page", "https://breatic.ai/login?next=%2Fstudio", "https://breatic.ai/studio", "allow"],
    ["Stripe checkout", "https://checkout.stripe.com/c/pay/cs_1", "https://breatic.ai/studio/ada/settings", "allow"],
    ["a Stripe invoice", "https://invoice.stripe.com/i/acct_1/x", "https://breatic.ai/studio/ada", "allow"],
    ["a payment method leaving Stripe", "https://www.paypal.com/checkoutnow?token=1", "https://checkout.stripe.com/c/pay/cs_1", "allow"],
    ["the way back from Stripe", "https://breatic.ai/studio/ada?checkout=done", "https://www.paypal.com/x", "allow"],
    ["the official terms page", "https://breatic.ai/terms/", "https://breatic.ai/login", "external"],
    ["the official home page", "https://breatic.ai/", "https://breatic.ai/studio", "external"],
    ["another site", "https://example.com/", "https://breatic.ai/studio", "external"],
    ["a plain-http page from an app page", "http://example.com/", "https://breatic.ai/studio", "external"],
    ["an email link", "mailto:support@breatic.ai", "https://breatic.ai/login", "external"],
    ["a local file", "file:///etc/passwd", "https://breatic.ai/studio", "deny"],
    ["script", "javascript:alert(1)", "https://breatic.ai/studio", "deny"],
    ["a Stripe look-alike", "https://stripe.com.evil.test/pay", "https://breatic.ai/studio", "external"],
    ["plain http while on Stripe", "http://example.com/", "https://checkout.stripe.com/c/pay/cs_1", "external"],
  ])("%s → %s", (_label, url, currentUrl, expected) => {
    expect(decideNavigation({ url, currentUrl, serverOrigin: SERVER })).toBe(expected);
  });

  it("keeps a self-hosted server's own pages", () => {
    expect(decideNavigation({ url: "http://localhost:8100/studio", currentUrl: "", serverOrigin: "http://localhost:8100" })).toBe("allow");
  });
});

describe("decideWindowOpen", () => {
  it.each([
    ["an asset download", "https://assets.breatic.ai/a/b.png?download=1", "download"],
    ["a same-origin asset download", "https://breatic.ai/files/x.mp4?download=1", "download"],
    ["an app page in a new tab", "https://breatic.ai/studio/ada", "window"],
    ["the official tutorials", "https://breatic.ai/tutorials/", "external"],
    ["an asset preview", "https://assets.breatic.ai/a/b.png", "external"],
    ["another site", "https://docs.example.com/", "external"],
    ["an email link", "mailto:support@breatic.ai", "external"],
    ["a local file", "file:///tmp/x", "deny"],
    ["a download over another scheme", "file:///tmp/x?download=1", "deny"],
  ])("%s → %s", (_label, url, expected) => {
    expect(decideWindowOpen({ url, serverOrigin: SERVER })).toBe(expected);
  });
});

describe("isServerLoadFailure", () => {
  it("is a main-frame load of the server that failed", () => {
    expect(isServerLoadFailure({ url: "https://breatic.ai/studio", serverOrigin: SERVER, isMainFrame: true, errorCode: -105 })).toBe(true);
  });

  it.each([
    ["a cancelled load", { url: "https://breatic.ai/studio", isMainFrame: true, errorCode: -3 }],
    ["a frame inside the page", { url: "https://breatic.ai/studio", isMainFrame: false, errorCode: -105 }],
    ["a Stripe page", { url: "https://checkout.stripe.com/x", isMainFrame: true, errorCode: -105 }],
  ])("is not %s", (_label, failure) => {
    expect(isServerLoadFailure({ ...failure, serverOrigin: SERVER })).toBe(false);
  });
});
