// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { describe, it, expect, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: { REDIS_KEY_PREFIX: "dev" } as { REDIS_KEY_PREFIX: string },
}));

vi.mock("@core/config/env.js", () => ({ env: envMock }));

import { sessionCookieName } from "@core/infra/session-store.js";

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
