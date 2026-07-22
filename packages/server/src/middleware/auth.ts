// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Authentication middleware.
 *
 * Reads the session token from the httpOnly `breatic_session` cookie,
 * resolves it via the session store, and sets the user entity on the
 * Hono context.
 *
 * Bearer/Authorization-header auth has been removed (2026-05-26) —
 * the cookie is the single canonical channel so XSS payloads cannot
 * exfiltrate the session token from the page.
 */

import type { MiddlewareHandler } from "hono";
import { authService } from "@server/modules";
import { logger } from "@breatic/core";
import { creditRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import { readSessionCookie } from "@server/middleware/session-cookie.js";

/** Hono context variables set by auth middleware. */
export interface AuthVariables {
  user: {
    id: string;
    email: string;
    credits: number;
  };
}

/**
 * Require authentication — returns 401 if the session cookie is
 * missing or invalid.
 * @param c - The Hono request context; the resolved user (id, email, credits) is set on it.
 * @param next - The downstream handler, invoked only when authentication succeeds.
 * @returns A 401 JSON response when the session cookie is missing or expired; otherwise nothing (control passes to `next`).
 */
export const requireAuth: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) {
    logger.warn({ reason: "no_token", path: c.req.path }, "auth_rejected");
    return c.json({ error: { code: 401, message: t("server.auth.not_authenticated") } }, 401);
  }

  const user = await authService.getUserByToken(token);
  if (!user) {
    logger.warn({ reason: "session_expired", path: c.req.path }, "auth_rejected");
    return c.json({ error: { code: 401, message: t("server.auth.token_expired") } }, 401);
  }

  const credits = await creditRepo.getBalance(user.id);
  c.set("user", {
    id: user.id,
    email: user.email,
    credits,
  });
  await next();
};
