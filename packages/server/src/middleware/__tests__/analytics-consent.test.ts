// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { CONSENT_COOKIE_NAME, CONSENT_REVISION, NO_CONSENT } from "@breatic/shared";
import { currentAdsBrowser, currentConsent, currentConsentSeen } from "@breatic/core";
import { analyticsConsentMiddleware } from "@server/middleware/analytics-consent.js";

function appSeeingConsent(): Hono {
  const app = new Hono();
  app.use("*", analyticsConsentMiddleware);
  app.get("/probe", async (c) => {
    await Promise.resolve();
    return c.json(currentConsent());
  });
  app.get("/browser", (c) => c.json({ ads: currentAdsBrowser(), seen: currentConsentSeen() }));
  return app;
}

function cookieHeader(categories: string[], revision = CONSENT_REVISION, source = "banner"): string {
  const entry = { decidedAt: new Date().toISOString(), source };
  const data = { analytics: entry, ads: entry };
  const value = encodeURIComponent(JSON.stringify({ categories, revision, data }));
  return `${CONSENT_COOKIE_NAME}=${value}; other=1`;
}

describe("analyticsConsentMiddleware", () => {
  it("hands the browser's choice to the handler", async () => {
    const res = await appSeeingConsent().request("/probe", {
      headers: { Cookie: cookieHeader(["necessary", "analytics"]) },
    });
    expect(await res.json()).toEqual({ analytics: true, ads: false });
  });

  it("treats a request without the cookie as no consent", async () => {
    const res = await appSeeingConsent().request("/probe");
    expect(await res.json()).toEqual(NO_CONSENT);
  });

  it("treats a choice from an older policy revision as no consent", async () => {
    const res = await appSeeingConsent().request("/probe", {
      headers: { Cookie: cookieHeader(["analytics", "ads"], CONSENT_REVISION - 1) },
    });
    expect(await res.json()).toEqual(NO_CONSENT);
  });

  it("hands on the browser's ads consent, whether it sent GPC, and the choices it would record", async () => {
    const res = await appSeeingConsent().request("/browser", {
      headers: { Cookie: cookieHeader(["necessary", "ads"]), "Sec-GPC": "1" },
    });
    expect(await res.json()).toEqual({
      ads: { consent: true, gpc: true },
      seen: { analytics: { value: false, revision: CONSENT_REVISION }, ads: { value: true, revision: CONSENT_REVISION } },
    });
  });

  it("records nothing as seen for regional defaults", async () => {
    const res = await appSeeingConsent().request("/browser", {
      headers: { Cookie: cookieHeader(["necessary", "analytics"], CONSENT_REVISION, "implicit") },
    });
    expect(await res.json()).toEqual({ ads: { consent: false, gpc: false }, seen: null });
  });
});
