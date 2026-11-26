// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Which browser origins the credentialed services trust, and which origin an
 * emailed link points at (inner#2157 design 7.5).
 *
 * `ALLOWED_ORIGINS` stays an exact list. An influencer site
 * (`<label>.partner.<domain>`) is trusted when its host is registered in the
 * influencers table, disabled ones included (their existing users keep using
 * the site), and its scheme and port equal the first `ALLOWED_ORIGINS` item.
 * The registered hosts are cached in-process for 60 seconds, so a newly
 * opened influencer works within a minute without a restart (V7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FrontendOrigin from "@core/http/frontend-origin.js";

const { envMock, listHosts } = vi.hoisted(() => ({
  envMock: {
    ALLOWED_ORIGINS: "https://app.example.com, https://preview.example.com",
    COOKIE_DOMAIN: "example.com",
  },
  listHosts: vi.fn<() => Promise<string[]>>(),
}));

vi.mock("@core/config/env.js", () => ({ env: envMock }));
vi.mock("@core/influencer/influencer.repo.js", () => ({ listHosts }));

type FrontendOriginModule = typeof FrontendOrigin;

/**
 * A fresh copy of the module, so the 60-second host cache of one case never
 * answers for another.
 * @returns The module under test.
 */
async function load(): Promise<FrontendOriginModule> {
  vi.resetModules();
  return import("../frontend-origin.js");
}

beforeEach(() => {
  envMock.ALLOWED_ORIGINS = "https://app.example.com, https://preview.example.com";
  envMock.COOKIE_DOMAIN = "example.com";
  listHosts.mockReset();
  listHosts.mockResolvedValue(["alice.partner.example.com", "retired.partner.example.com"]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("frontend links", () => {
  it("uses the configured frontend for absent or untrusted request origins", async () => {
    const { frontendOrigin } = await load();
    for (const origin of [undefined, "null", "https://attacker.example", "https://backend.example.com"]) {
      expect(frontendOrigin(origin)).toBe("https://app.example.com");
    }
  });

  it("preserves an explicitly allowed second frontend", async () => {
    const { frontendOrigin } = await load();
    expect(frontendOrigin("https://preview.example.com")).toBe("https://preview.example.com");
  });

  // Callers with no request origin (invitation service, commerce referral
  // links) keep the synchronous, configuration-only answer.
  it("stays synchronous and never consults the influencer table", async () => {
    const { frontendOrigin } = await load();

    const answer = frontendOrigin("https://alice.partner.example.com");

    expect(answer).toBe("https://app.example.com");
    expect(listHosts).toHaveBeenCalledTimes(0);
  });
});

describe("isTrustedFrontendOrigin", () => {
  it.each(["https://app.example.com", "https://preview.example.com"])(
    "trusts the exact ALLOWED_ORIGINS item %s",
    async (origin) => {
      const { isTrustedFrontendOrigin } = await load();

      expect(await isTrustedFrontendOrigin(origin)).toBe(true);
    },
  );

  it("trusts a registered influencer host on the first item's scheme and port", async () => {
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin("https://alice.partner.example.com")).toBe(true);
  });

  // Disabling only changes whom new sign-ups are credited to (design 7.2);
  // users already on that site keep working there.
  it("still trusts a disabled influencer host, since listHosts returns it", async () => {
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin("https://retired.partner.example.com")).toBe(true);
  });

  it.each([
    "https://bob.partner.example.com",
    "https://partner.example.com",
    "https://alice.example.com",
    "https://alice.partner.example.com.attacker.test",
    "https://attacker.test",
  ])("refuses the unregistered origin %s", async (origin) => {
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin(origin)).toBe(false);
  });

  it.each([
    ["a different scheme", "http://alice.partner.example.com"],
    ["an explicit port the first item lacks", "https://alice.partner.example.com:8443"],
  ])("refuses a registered host with %s", async (_label, origin) => {
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin(origin)).toBe(false);
  });

  it.each(["null", "", "not a url", "https://alice.partner.example.com/register"])(
    "refuses the malformed origin %j",
    async (origin) => {
      const { isTrustedFrontendOrigin } = await load();

      expect(await isTrustedFrontendOrigin(origin)).toBe(false);
    },
  );

  // Local development: the first item is http with a port, and an influencer
  // site is the same scheme and port under `*.partner.localhost`.
  it("takes scheme and port from the first item in local development", async () => {
    envMock.ALLOWED_ORIGINS = "http://localhost:8000";
    envMock.COOKIE_DOMAIN = "localhost";
    listHosts.mockResolvedValue(["alice.partner.localhost"]);
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin("http://alice.partner.localhost:8000")).toBe(true);
    expect(await isTrustedFrontendOrigin("http://alice.partner.localhost:8001")).toBe(false);
    expect(await isTrustedFrontendOrigin("http://alice.partner.localhost")).toBe(false);
    expect(await isTrustedFrontendOrigin("https://alice.partner.localhost:8000")).toBe(false);
  });

  it("reads the registered hosts once and serves them from cache inside 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(new Date("2026-11-26T00:00:00.000Z"));
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin("https://alice.partner.example.com")).toBe(true);
    listHosts.mockResolvedValue(["alice.partner.example.com", "newcomer.partner.example.com"]);
    vi.advanceTimersByTime(59_000);

    expect(await isTrustedFrontendOrigin("https://newcomer.partner.example.com")).toBe(false);
    expect(listHosts).toHaveBeenCalledTimes(1);
  });

  it("picks up a newly registered host once the 60-second cache has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(new Date("2026-11-26T00:00:00.000Z"));
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin("https://newcomer.partner.example.com")).toBe(false);
    listHosts.mockResolvedValue(["alice.partner.example.com", "newcomer.partner.example.com"]);
    vi.advanceTimersByTime(60_001);

    expect(await isTrustedFrontendOrigin("https://newcomer.partner.example.com")).toBe(true);
    expect(listHosts).toHaveBeenCalledTimes(2);
  });

  it("does not read the influencer table for an exact ALLOWED_ORIGINS match", async () => {
    const { isTrustedFrontendOrigin } = await load();

    expect(await isTrustedFrontendOrigin("https://app.example.com")).toBe(true);
    expect(listHosts).toHaveBeenCalledTimes(0);
  });
});

describe("frontendOriginFor", () => {
  it("returns the request origin of a registered influencer site", async () => {
    const { frontendOriginFor } = await load();

    expect(await frontendOriginFor("https://alice.partner.example.com")).toBe("https://alice.partner.example.com");
  });

  it("returns the request origin of a disabled influencer site", async () => {
    const { frontendOriginFor } = await load();

    expect(await frontendOriginFor("https://retired.partner.example.com")).toBe("https://retired.partner.example.com");
  });

  it("returns an exact ALLOWED_ORIGINS item unchanged", async () => {
    const { frontendOriginFor } = await load();

    expect(await frontendOriginFor("https://preview.example.com")).toBe("https://preview.example.com");
  });

  it.each([undefined, "null", "https://bob.partner.example.com", "http://alice.partner.example.com", "https://attacker.test"])(
    "falls back to the first exact origin for %j",
    async (origin) => {
      const { frontendOriginFor } = await load();

      expect(await frontendOriginFor(origin)).toBe("https://app.example.com");
    },
  );
});
