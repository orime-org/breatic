// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Authentication middleware.
 *
 * In the global region it reads the session token from the httpOnly session
 * cookie (`sessionCookieName()` — deployment-scoped, see
 * `@core/infra/session-store`) and resolves it via the session store; in any
 * other region it reads the identity token cookie (`identityCookieName()`)
 * and verifies it with `IDENTITY_PUBLIC_KEYS` (inner#1955). Either way it
 * sets the user entity on the Hono context. People sign in only this way:
 * the cookie keeps the session token out of reach of a script on the page.
 *
 * A request with no session cookie may instead carry a downstream token in
 * `Authorization: Bearer` (#1488 §5.5): the short-lived token the MCP service
 * calls with on an external agent's behalf. It is accepted only on the
 * routes in `DOWNSTREAM_TOKEN_ROUTES`, and sets `agent` beside `user`. An
 * agent's own OAuth or personal access token is never accepted here.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import * as Sentry from "@sentry/node";
import { authService } from "@server/modules";
import { env, getRedis, identityCookieName, isIdentityRevoked, logger, verifyIdentityToken, isGlobalRegion } from "@breatic/core";
import { t, type MembershipTier } from "@breatic/shared";
import { readSessionCookie } from "@server/middleware/session-cookie.js";
import { authenticateDownstream, type DownstreamAgent } from "@server/modules/agent-access/downstream-auth.js";

/** The `error.reason` of a 401 the page answers by renewing its identity token once. */
export const IDENTITY_EXPIRED_REASON = "identity_expired";

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
 * Require authentication — returns 401 if the session cookie (the identity
 * cookie outside the global region) is invalid, or when there is none and no
 * downstream token is accepted.
 * @param c - The Hono request context; the resolved user (id, email, membershipTier, locale) is set on it.
 * @param next - The downstream handler, invoked only when authentication succeeds.
 * @returns A 401 JSON response when the cookie is expired, or missing with no downstream token accepted; a 429 when a downstream request's total is spent; otherwise nothing (control passes to `next`).
 */
export const requireAuth: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  if (!isGlobalRegion(env)) {
    const user = await userFromIdentityToken(c);
    if (user instanceof Response) return user;
    c.set("user", user);
    Sentry.setUser({ id: user.id });
    await next();
    return;
  }
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

/**
 * The id of the user a request carries: the identity token outside the
 * global region, the session in it. For logs about a request refused before
 * authentication; it never answers, so outside the global region it skips
 * the revocation tombstone `requireAuth` checks, and a revoked token that has
 * not expired still names its user.
 * @param c - The request context.
 * @returns The user id, or null when the request carries no valid one.
 * @throws {Error} When the session store cannot be read (global region).
 */
export async function requestUserId(c: Context): Promise<string | null> {
  if (!isGlobalRegion(env)) {
    const cookie = getCookie(c, identityCookieName());
    if (!cookie) return null;
    const verdict = verifyIdentityToken(cookie, env.IDENTITY_PUBLIC_KEYS, Math.floor(Date.now() / 1000));
    return verdict.ok ? verdict.claims.sub : null;
  }
  const token = readSessionCookie(c);
  if (!token) return null;
  return (await authService.getUserByToken(token))?.id ?? null;
}

/**
 * Who is asking, in a region that does not hold the sessions: the identity
 * token cookie checked with the public keys and this region's revocation
 * tombstones, with no call to the global region.
 * @param c - The request context.
 * @returns The user, or the 401 to answer with.
 * @throws {Error} When Redis cannot be read for the tombstone.
 */
async function userFromIdentityToken(c: Context): Promise<AuthVariables["user"] | Response> {
  const cookie = getCookie(c, identityCookieName());
  if (!cookie) {
    logger.warn({ reason: "no_identity", path: c.req.path }, "auth_rejected");
    return c.json({ error: { code: 401, message: t("server.auth.not_authenticated") } }, 401);
  }
  const verdict = verifyIdentityToken(cookie, env.IDENTITY_PUBLIC_KEYS, Math.floor(Date.now() / 1000));
  if (!verdict.ok) {
    logger.warn({ reason: `identity_${verdict.reason}`, path: c.req.path }, "auth_rejected");
    // A key this region no longer holds is a token from before a rotation;
    // renewing it still takes the user's real session at the global region.
    if (verdict.reason === "expired" || verdict.reason === "unknown_key") {
      return c.json(
        { error: { code: 401, message: t("server.auth.token_expired"), reason: IDENTITY_EXPIRED_REASON } },
        401,
      );
    }
    return c.json({ error: { code: 401, message: t("server.auth.not_authenticated") } }, 401);
  }
  if (await isIdentityRevoked(getRedis(), verdict.claims.sid)) {
    logger.warn({ reason: "identity_revoked", path: c.req.path }, "auth_rejected");
    return c.json({ error: { code: 401, message: t("server.auth.token_expired") } }, 401);
  }
  return {
    id: verdict.claims.sub,
    email: verdict.claims.email,
    membershipTier: verdict.claims.tier,
    locale: verdict.claims.locale,
  };
}
