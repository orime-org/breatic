// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the desktop client does with a page that navigates or opens a window
 * (inner#2041, design §7).
 *
 * The app's own pages stay in the client; links elsewhere go to the system
 * browser, as do the official site's own pages (same origin, not the app).
 * Stripe checkout runs in the window, so paying returns to the signed-in
 * client, and a payment method that leaves Stripe stays until it comes back.
 * Asset downloads land in the client's save dialog.
 */

import { describe, it, expect, vi } from "vitest";

import { decideNavigation, decideWindowOpen, isCertificateError, isServerLoadFailure, stepHistory } from "@desktop/main/navigation.js";

const SERVER = "https://app.example.com";

describe("decideNavigation", () => {
  it.each([
    ["an app page", "https://app.example.com/studio/ada", "https://app.example.com/login", "allow"],
    ["the sign-in page", "https://app.example.com/login?next=%2Fstudio", "https://app.example.com/studio", "allow"],
    ["Stripe checkout", "https://checkout.stripe.com/c/pay/cs_1", "https://app.example.com/studio/ada/settings", "allow"],
    ["a Stripe invoice", "https://invoice.stripe.com/i/acct_1/x", "https://app.example.com/studio/ada", "allow"],
    ["a payment method leaving Stripe", "https://www.paypal.com/checkoutnow?token=1", "https://checkout.stripe.com/c/pay/cs_1", "allow"],
    ["the way back from Stripe", "https://app.example.com/studio/ada?checkout=done", "https://www.paypal.com/x", "allow"],
    ["the official terms page", "https://app.example.com/terms/", "https://app.example.com/login", "external"],
    ["the official home page", "https://app.example.com/", "https://app.example.com/studio", "external"],
    ["another site", "https://example.com/", "https://app.example.com/studio", "external"],
    ["a plain-http page from an app page", "http://example.com/", "https://app.example.com/studio", "external"],
    ["an email link", "mailto:support@app.example.com", "https://app.example.com/login", "external"],
    ["a local file", "file:///etc/passwd", "https://app.example.com/studio", "deny"],
    ["script", "javascript:alert(1)", "https://app.example.com/studio", "deny"],
    ["a Stripe look-alike", "https://stripe.com.evil.test/pay", "https://app.example.com/studio", "external"],
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
    ["an asset download", "https://assets.app.example.com/a/b.png?download=1", "download"],
    ["a same-origin asset download", "https://app.example.com/files/x.mp4?download=1", "download"],
    ["an app page in a new tab", "https://app.example.com/studio/ada", "window"],
    ["the official tutorials", "https://app.example.com/tutorials/", "external"],
    ["an asset preview", "https://assets.app.example.com/a/b.png", "external"],
    ["another site", "https://docs.example.com/", "external"],
    ["an email link", "mailto:support@app.example.com", "external"],
    ["a local file", "file:///tmp/x", "deny"],
    ["a download over another scheme", "file:///tmp/x?download=1", "deny"],
  ])("%s → %s", (_label, url, expected) => {
    expect(decideWindowOpen({ url, serverOrigin: SERVER })).toBe(expected);
  });
});

describe("isServerLoadFailure", () => {
  it("is a main-frame load of the server that failed", () => {
    expect(isServerLoadFailure({ url: "https://app.example.com/studio", serverOrigin: SERVER, isMainFrame: true, errorCode: -105 })).toBe(true);
  });

  it.each([
    ["a cancelled load", { url: "https://app.example.com/studio", isMainFrame: true, errorCode: -3 }],
    ["a frame inside the page", { url: "https://app.example.com/studio", isMainFrame: false, errorCode: -105 }],
    ["a Stripe page", { url: "https://checkout.stripe.com/x", isMainFrame: true, errorCode: -105 }],
  ])("is not %s", (_label, failure) => {
    expect(isServerLoadFailure({ ...failure, serverOrigin: SERVER })).toBe(false);
  });
});

describe("isCertificateError", () => {
  it.each([[-202, true], [-200, true], [-299, true], [-105, false], [-300, false]])("treats %i as a certificate error: %s", (code, expected) => {
    expect(isCertificateError(code)).toBe(expected);
  });
});

describe("stepHistory", () => {
  /** A window's history with one entry behind and none ahead. */
  function history(): { canGoBack: () => boolean; canGoForward: () => boolean; goBack: ReturnType<typeof vi.fn>; goForward: ReturnType<typeof vi.fn> } {
    return { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
  }

  it.each([["back", "browser-backward"], ["back", "back"]] as const)("goes back for %s (%s)", (_direction, command) => {
    const h = history();
    stepHistory(h, command);
    expect(h.goBack).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there is nowhere to go, or for another command", () => {
    const h = history();
    stepHistory(h, "browser-forward");
    stepHistory(h, "forward");
    stepHistory(h, "media-play-pause");
    stepHistory(undefined, "back");
    expect(h.goForward).not.toHaveBeenCalled();
    expect(h.goBack).not.toHaveBeenCalled();
  });
});
