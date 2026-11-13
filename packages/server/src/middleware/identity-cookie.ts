// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The identity token cookie (inner#1955).
 *
 * The global region signs who the user is into `breatic_identity` whenever it
 * resolves a session for the page (`GET /auth/me`, `POST /auth/identity`);
 * regions that do not hold the sessions read the cookie in `requireAuth` and
 * verify it with the public keys alone. A deployment without a signing key
 * writes no cookie at all.
 */

import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  backfillSessionIdIndex,
  env,
  getRedis,
  IDENTITY_COOKIE_NAME,
  IDENTITY_TOKEN_TTL_SECONDS,
  sessionId,
  signIdentityToken,
  type IdentityClaimsInput,
} from "@breatic/core";

/** Who the token says the user is, besides the session it came from. */
export interface IdentitySubject {
  userId: string;
  email: string;
  tier: IdentityClaimsInput["tier"];
  locale: string;
  personalStudio: IdentityClaimsInput["personalStudio"];
}

/**
 * Sign the user's identity and write it as a cookie on the response.
 * @param c - The request context.
 * @param subject - Who the user is.
 * @param sessionToken - The session the request resolved.
 * @throws {Error} When Redis cannot backfill the session id index.
 */
export async function writeIdentityCookie(c: Context, subject: IdentitySubject, sessionToken: string): Promise<void> {
  if (env.IDENTITY_SIGNING_KEY.trim() === "") return;
  // Sessions made before the id index existed get it here, so the global
  // region can answer other regions' revocation checks for them.
  await backfillSessionIdIndex(getRedis(), sessionToken);
  const token = signIdentityToken(
    {
      sub: subject.userId,
      sid: sessionId(sessionToken),
      email: subject.email,
      tier: subject.tier,
      locale: subject.locale,
      personalStudio: subject.personalStudio,
    },
    { kid: env.IDENTITY_SIGNING_KEY_ID, privateKey: env.IDENTITY_SIGNING_KEY },
    Math.floor(Date.now() / 1000),
  );
  setCookie(c, IDENTITY_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: IDENTITY_TOKEN_TTL_SECONDS,
    ...(env.IDENTITY_COOKIE_DOMAIN.trim() !== "" ? { domain: env.IDENTITY_COOKIE_DOMAIN.trim() } : {}),
  });
}

/**
 * Remove the identity token cookie when the session it names ends.
 * @param c - The request context.
 */
export function clearIdentityCookie(c: Context): void {
  deleteCookie(c, IDENTITY_COOKIE_NAME, {
    path: "/",
    secure: true,
    ...(env.IDENTITY_COOKIE_DOMAIN.trim() !== "" ? { domain: env.IDENTITY_COOKIE_DOMAIN.trim() } : {}),
  });
}
