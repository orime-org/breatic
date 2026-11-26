// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Session cookie naming (#1831).
 *
 * Cookies are not scoped by port (RFC 6265 §8.5) — every service on `localhost`
 * shares one cookie jar. Two deployments using the same cookie name therefore
 * overwrite each other's token on every login, and since each looks its token
 * up in its own Redis DB, the other side silently reads as logged out. Ports
 * isolate the servers; only the NAME isolates the cookie.
 *
 * The suffix is asserted end to end because the value is what a browser stores:
 * a mismatch between what the server writes and what collab reads off the
 * WebSocket upgrade is an auth failure with no error to trace.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: { REDIS_KEY_PREFIX: "dev", COOKIE_DOMAIN: "" },
}));

vi.mock("@core/config/env.js", () => ({ env: envMock }));

import { cookieDomainHost, sessionCookieName } from "@core/infra/session-store.js";

beforeEach(() => {
  envMock.REDIS_KEY_PREFIX = "dev";
  envMock.COOKIE_DOMAIN = "";
});

describe("sessionCookieName", () => {
  it("carries the deployment prefix", () => {
    envMock.REDIS_KEY_PREFIX = "dev";

    expect(sessionCookieName()).toBe("breatic_session_dev");
  });

  it("differs between deployments so their cookies cannot evict each other", () => {
    envMock.REDIS_KEY_PREFIX = "dev";
    const mine = sessionCookieName();
    envMock.REDIS_KEY_PREFIX = "dev-agent";
    const theirs = sessionCookieName();

    expect(mine).not.toBe(theirs);
  });

  // A cookie name is a `token` per RFC 6265 §4.1.1: no spaces, no separators
  // like ; , = ( ) < > @ : \ " / [ ] ? { }. The prefix is regex-constrained in
  // the env schema, and this is the reason why — a name violating the grammar
  // is silently dropped by the browser, which reads as "login does nothing".
  it.each(["dev", "dev-agent", "dev_agent", "staging2", "prod"])(
    "with prefix %s the name stays a legal cookie token",
    (prefix) => {
      envMock.REDIS_KEY_PREFIX = prefix;

      expect(sessionCookieName()).toMatch(/^[A-Za-z0-9_-]+$/);
    },
  );
});

/**
 * Site-wide sign-in (inner#2157 V11, design 7.5 and 7.9). `COOKIE_DOMAIN` is
 * written by operators in more than one shape (`.thinkai.cc` in the
 * session-cookie comment, a bare host, stray capitals or spaces); every
 * consumer reads it through `cookieDomainHost()` so the cookie `Domain`, the
 * influencer host suffix and the cookie name all agree.
 */
describe("cookieDomainHost", () => {
  it.each([
    ["breatic.ai", "breatic.ai"],
    [".breatic.ai", "breatic.ai"],
    [".Breatic.AI", "breatic.ai"],
    ["  .breatic.ai  ", "breatic.ai"],
    ["BREATIC.AI", "breatic.ai"],
    ["localhost", "localhost"],
  ])("normalises %j to %j", (raw, host) => {
    envMock.COOKIE_DOMAIN = raw;

    expect(cookieDomainHost()).toBe(host);
  });

  it.each(["", "   "])("is empty when COOKIE_DOMAIN is %j", (raw) => {
    envMock.COOKIE_DOMAIN = raw;

    expect(cookieDomainHost()).toBe("");
  });
});

/**
 * A site-wide credential gets a name of its own, so a host-only cookie issued
 * before the switch can never shadow it on the same host (design 7.9 row
 * 全站会话).
 */
describe("sessionCookieName with a site-wide cookie domain", () => {
  it("names the site-wide credential breatic_site_session_<prefix> when COOKIE_DOMAIN is set", () => {
    envMock.COOKIE_DOMAIN = "breatic.ai";
    envMock.REDIS_KEY_PREFIX = "prod";

    expect(sessionCookieName()).toBe("breatic_site_session_prod");
  });

  it("uses the normalised domain, so a leading dot or capitals still mean site-wide", () => {
    envMock.COOKIE_DOMAIN = " .Breatic.ai ";
    envMock.REDIS_KEY_PREFIX = "dev";

    expect(sessionCookieName()).toBe("breatic_site_session_dev");
  });

  it("keeps the host-only name breatic_session_<prefix> when COOKIE_DOMAIN is blank", () => {
    envMock.COOKIE_DOMAIN = "  ";
    envMock.REDIS_KEY_PREFIX = "dev";

    expect(sessionCookieName()).toBe("breatic_session_dev");
  });

  it("never gives the site-wide and host-only credentials the same name", () => {
    envMock.REDIS_KEY_PREFIX = "prod";
    envMock.COOKIE_DOMAIN = "";
    const hostOnly = sessionCookieName();
    envMock.COOKIE_DOMAIN = "breatic.ai";
    const siteWide = sessionCookieName();

    expect([hostOnly, siteWide]).toEqual(["breatic_session_prod", "breatic_site_session_prod"]);
  });
});
