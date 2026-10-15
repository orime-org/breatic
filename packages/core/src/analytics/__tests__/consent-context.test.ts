// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { NO_CONSENT } from "@breatic/shared";
import {
  currentAdsBrowser,
  currentConsent,
  runWithConsent,
} from "@core/analytics/consent-context.js";

describe("request consent context", () => {
  it("reads no consent outside a request", () => {
    expect(currentConsent()).toEqual(NO_CONSENT);
  });

  it("exposes the snapshot to everything the request awaits", async () => {
    const seen = await runWithConsent({ analytics: true, ads: false }, async () => {
      await Promise.resolve();
      return currentConsent();
    });
    expect(seen).toEqual({ analytics: true, ads: false });
  });

  it("keeps concurrent requests apart", async () => {
    const [a, b] = await Promise.all([
      runWithConsent({ analytics: true, ads: true }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentConsent();
      }),
      runWithConsent({ analytics: false, ads: false }, async () => currentConsent()),
    ]);
    expect(a).toEqual({ analytics: true, ads: true });
    expect(b).toEqual({ analytics: false, ads: false });
  });

  it("reads no consent again once the request is over", async () => {
    await runWithConsent({ analytics: true, ads: true }, async () => undefined);
    expect(currentConsent()).toEqual(NO_CONSENT);
  });

  it("reads a browser with no ads choice when no browser was read", async () => {
    expect(currentAdsBrowser()).toEqual({ consent: false });
    const inside = await runWithConsent({ analytics: true, ads: true }, async () => currentAdsBrowser());
    expect(inside).toEqual({ consent: false });
  });

  it("exposes the browser's ads snapshot", async () => {
    const browser = { ads: { consent: true } };
    const inside = await runWithConsent({ analytics: false, ads: true }, async () => currentAdsBrowser(), browser);
    expect(inside).toEqual(browser.ads);
  });
});
