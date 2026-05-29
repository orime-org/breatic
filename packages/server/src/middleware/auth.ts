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
import { authService } from "@breatic/core";
import { t } from "@breatic/shared";
import { readSessionCookie } from "@server/middleware/session-cookie.js";

/** Hono context variables set by auth middleware. */
export interface AuthVariables {
  user: {
    id: string;
    email: string;
    username: string | null;
    avatarUrl: string | null;
    credits: number;
  };
}

/**
 * Require authentication — returns 401 if the session cookie is
 * missing or invalid.
 */
export const requireAuth: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) {
    return c.json({ error: { code: 401, message: t("server.auth.not_authenticated") } }, 401);
  }

  const user = await authService.getUserByToken(token);
  if (!user) {
    return c.json({ error: { code: 401, message: t("server.auth.token_expired") } }, 401);
  }

  c.set("user", {
    id: user.id,
    email: user.email,
    username: user.username,
    avatarUrl: user.avatarUrl,
    credits: user.credits,
  });
  await next();
};
