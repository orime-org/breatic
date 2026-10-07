// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ setUser: vi.fn() }));
vi.mock("@sentry/node", () => sentry);

const session = vi.hoisted((): { token: string | null } => ({ token: "session-token" }));
vi.mock("@server/middleware/session-cookie.js", () => ({
  readSessionCookie: () => session.token,
}));

const accounts = vi.hoisted(() => ({ getUserByToken: vi.fn() }));
vi.mock("@server/modules", () => ({ authService: accounts }));

// `logger` reads config on first use; the rejection path writes through it.
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { loadLocales } from "@breatic/core";
import { requireAuth } from "@server/middleware/auth.js";

loadLocales();

/**
 * A one-route app behind `requireAuth`.
 * @returns The app.
 */
function app(): Hono {
  const hono = new Hono();
  hono.get("/me", requireAuth, (c) => c.text("ok"));
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  session.token = "session-token";
});

describe("requireAuth and error monitoring", () => {
  it("attaches only the account id to errors raised while serving the request", async () => {
    accounts.getUserByToken.mockResolvedValue({
      id: "user-1",
      email: "reader@example.test",
      membershipTier: "base",
      locale: "en",
    });

    const res = await app().request("/me");

    expect(res.status).toBe(200);
    expect(sentry.setUser).toHaveBeenCalledTimes(1);
    expect(sentry.setUser).toHaveBeenCalledWith({ id: "user-1" });
  });

  it("attaches no user when the session is missing", async () => {
    session.token = null;

    const res = await app().request("/me");

    expect(res.status).toBe(401);
    expect(sentry.setUser).not.toHaveBeenCalled();
  });
});
