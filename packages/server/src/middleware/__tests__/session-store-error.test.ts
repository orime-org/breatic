// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { accounts, logged } = vi.hoisted(() => ({
  accounts: { getUserByToken: vi.fn() },
  logged: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@server/middleware/session-cookie.js", () => ({
  readSessionCookie: () => "session-token",
}));

vi.mock("@server/modules", () => ({ authService: accounts }));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import { loadLocales, runWithLocale } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { errorHandler } from "@server/middleware/error-handler.js";

loadLocales();

/**
 * Exercise the authentication middleware and the real application error exit.
 */
function app(): Hono<{ Variables: AuthVariables }> {
  const application = new Hono<{ Variables: AuthVariables }>();
  application.onError(errorHandler);
  application.get("/me", requireAuth, (context) => context.text("ok"));
  return application;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session storage errors through requireAuth", () => {
  it.each(["Command timed out", "Connection is closed."])("keeps the diagnostic %s on the application 500 path", async (message) => {
    const rejection = Object.assign(new Error(message), {
      code: 503,
      sourceType: "ReplyError",
    });
    accounts.getUserByToken.mockRejectedValue(rejection);

    const response = await runWithLocale("en", () => app().request("/me"));
    const body: unknown = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: { code: 500, message: t("server.error.internal") } });
    expect(accounts.getUserByToken.mock.calls).toEqual([["session-token"]]);
    expect(logged.error).toHaveBeenCalledExactlyOnceWith({ err: rejection }, "Unhandled error");
    expect(logged.warn).not.toHaveBeenCalled();
    expect(rejection.message).toBe(message);
    expect(rejection.code).toBe(503);
  });
});
