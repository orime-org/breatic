/**
 * Session cookie helpers — centralized so the whole server writes,
 * reads, and clears the session cookie through one set of options.
 *
 * Session cookies are httpOnly + sameSite=Lax + (secure when not dev),
 * 30-day TTL. The optional `COOKIE_DOMAIN` env var lets prod set a
 * parent domain (e.g. `.thinkai.cc`) so the cookie is shared across
 * subdomains; dev leaves it unset so the browser scopes to
 * `localhost`.
 *
 * Why httpOnly: JS cannot read the cookie, so an XSS payload cannot
 * exfiltrate the session token. This is the whole point of the
 * cookie migration — if any code path leaks the token back into JS
 * (current-user store, WS query param, etc.) the XSS protection is
 * defeated.
 *
 * Why Lax (not Strict): cross-site link-clicks into the app
 * (password-reset email, share link from chat) still carry the
 * cookie. Strict would break first-touch reset flows. Lax is the
 * standard for session cookies in GitHub / Linear / Notion.
 *
 * Lives in the server package — Hono is an HTTP-server concern; the
 * shared `core` package must not depend on hono.
 */

import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { env, SESSION_COOKIE_NAME } from "@breatic/core";

// `SESSION_COOKIE_NAME` is the single source of truth in
// `@breatic/core` (session-store), shared with collab's onAuthenticate
// so the cookie name can never drift between the two services. Re-export
// it so existing `@server/middleware` importers keep their import path.
export { SESSION_COOKIE_NAME };

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Cookie options assembled from env. `secure` is auto-derived from
 * `ENV` — dev defaults `http://localhost` over plain TCP so a
 * `secure: true` cookie would be silently dropped by the browser.
 * Staging / prod must run over HTTPS, so `secure: true` is mandatory
 * there.
 * @returns The cookie options (httpOnly, secure, sameSite=Lax, path, 30-day maxAge, optional domain) shared by all session-cookie writes.
 */
function baseOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "Lax";
  path: "/";
  maxAge: number;
  domain?: string;
} {
  const domain = env.COOKIE_DOMAIN.trim();
  return {
    httpOnly: true,
    secure: env.ENV !== "dev",
    sameSite: "Lax",
    path: "/",
    maxAge: THIRTY_DAYS_SECONDS,
    ...(domain ? { domain } : {}),
  };
}

/**
 * Write the session cookie on the Hono response.
 * @param c - The Hono request context whose response receives the `Set-Cookie` header.
 * @param token - The opaque session token to store in the cookie.
 */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, baseOptions());
}

/**
 * Read the session cookie value from the Hono request.
 * @param c - The Hono request context whose cookies are read.
 * @returns The session token from the cookie, or `undefined` when the cookie is absent.
 */
export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

/**
 * Clear the session cookie. Must echo the same `path` + `domain` as
 * `setSessionCookie` or the browser will not match and the cookie
 * lingers.
 * @param c - The Hono request context whose response clears the session cookie.
 */
export function clearSessionCookie(c: Context): void {
  const domain = env.COOKIE_DOMAIN.trim();
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    ...(domain ? { domain } : {}),
  });
}
