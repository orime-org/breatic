// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Authentication middleware.
 *
 * Reads the session token from the httpOnly session cookie
 * (`sessionCookieName()` — deployment-scoped, see `@core/infra/session-store`),
 * resolves it via the session store, and sets the user entity on the
 * Hono context. People sign in only this way: the cookie keeps the session
 * token out of reach of a script on the page.
 *
 * A request with no session cookie may instead carry a downstream token in
 * `Authorization: Bearer` (#1488 §5.5): the short-lived token the MCP service
 * calls with on an external agent's behalf. It is accepted only on the
 * routes in `DOWNSTREAM_TOKEN_ROUTES`, and sets `agent` beside `user`. An
 * agent's own OAuth or personal access token is never accepted here.
 */

import type { MiddlewareHandler } from "hono";
import * as Sentry from "@sentry/node";
import { authService } from "@server/modules";
import { logger } from "@breatic/core";
import { t, type MembershipTier } from "@breatic/shared";
import { readSessionCookie } from "@server/middleware/session-cookie.js";
import { authenticateDownstream, type DownstreamAgent } from "@server/modules/agent-access/downstream-auth.js";

/** Hono context variables set by auth middleware. */
export interface AuthVariables {
  user: {
    id: string;
    email: string;
    /**
     * Which membership tier the account is on.
     *
     * Carried here because the entity this middleware resolves already has
     * it — the account row was read to authenticate the request, so naming
     * the tier costs nothing further. `/auth/me` hands it to the client,
     * where the avatar menu shows it in every studio's top bar.
     */
    membershipTier: MembershipTier;
    /**
     * The account's language. `/auth/me` hands it to the client, which
     * switches the interface to it when a page loads with a session.
     */
    locale: string;
  };
  /** The external agent a downstream-token request comes from; absent for people. */
  agent?: DownstreamAgent;
}

/**
 * Require authentication — returns 401 if the session cookie is invalid,
 * or when there is none and no downstream token is accepted.
 * @param c - The Hono request context; the resolved user (id, email, membershipTier, locale) is set on it.
 * @param next - The downstream handler, invoked only when authentication succeeds.
 * @returns A 401 JSON response when the cookie is expired, or missing with no downstream token accepted; a 429 when a downstream request's total is spent; otherwise nothing (control passes to `next`).
 */
export const requireAuth: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) return authenticateDownstream(c, next);

  const user = await authService.getUserByToken(token);
  if (!user) {
    logger.warn({ reason: "session_expired", path: c.req.path }, "auth_rejected");
    return c.json({ error: { code: 401, message: t("server.auth.token_expired") } }, 401);
  }

  c.set("user", {
    id: user.id,
    email: user.email,
    membershipTier: user.membershipTier,
    locale: user.locale,
  });
  // Errors raised while serving this request carry the account id, and
  // nothing else about the person (the Sentry request isolation scopes it).
  Sentry.setUser({ id: user.id });
  await next();
};
