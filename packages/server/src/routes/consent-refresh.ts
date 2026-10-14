// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `GET /_consent/refresh` (inner#1442 design §4.4.3a). The banner library
 * writes `breatic_consent` from script, and Safari caps script-written
 * cookies at seven days; a cookie set in an HTTP response is not capped. The
 * pages call this after every write, and the server writes the same value
 * back with the attributes the library used. The hosted site does this in its
 * frontend Worker; a self-hosted copy reaches here through nginx.
 */

import { Hono } from "hono";
import { CONSENT_COOKIE_NAME, CONSENT_MAX_AGE_DAYS } from "@breatic/shared";

const MAX_LENGTH = 4096;

/**
 * The Set-Cookie that writes the request's one readable consent cookie back.
 * @param cookieHeader - The request's Cookie header.
 * @param where - Where the library wrote it.
 * @param where.domain - Its Domain attribute; empty for none.
 * @param where.secure - Whether it carries Secure.
 * @param now - The time, in milliseconds.
 * @returns The Set-Cookie value, or null when there is no single readable value.
 */
function consentSetCookie(
  cookieHeader: string | undefined,
  where: { domain: string; secure: boolean },
  now: number,
): string | null {
  const values = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${CONSENT_COOKIE_NAME}=`))
    .map((part) => part.slice(CONSENT_COOKIE_NAME.length + 1));
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.length > MAX_LENGTH) return null;
  let stored: { consentId?: unknown; revision?: unknown; expirationTime?: unknown } | null;
  try {
    stored = JSON.parse(decodeURIComponent(value)) as typeof stored;
  } catch {
    return null;
  }
  const expires = stored?.expirationTime;
  if (typeof stored?.consentId !== "string" || stored.revision === undefined) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now) return null;
  const maxAge = Math.min(Math.floor((expires - now) / 1000), CONSENT_MAX_AGE_DAYS * 86400);
  const parts = [
    `${CONSENT_COOKIE_NAME}=${value}`,
    ...(where.domain === "" ? [] : [`Domain=${where.domain}`]),
    "Path=/",
    `Expires=${new Date(now + maxAge * 1000).toUTCString()}`,
    `Max-Age=${maxAge}`,
    ...(where.secure ? ["Secure"] : []),
    "SameSite=Lax",
  ];
  return parts.join("; ");
}

export const consentRefreshRoute = new Hono();

/**
 * The Domain attribute to write under: the domain the page's banner library wrote under, which only the page
 * knows (it is fixed when the frontend is built). The library sends no Domain on a host without a dot
 * (vanilla-cookieconsent 3.1.0); a domain the host does not belong to gets no write.
 * @param host - The page's host.
 * @param named - The domain the page names.
 * @returns The attribute value, empty for none, or null when nothing should be written.
 */
function cookieDomain(host: string, named: string | undefined): string | null {
  if (!host.includes(".")) return "";
  // A leading dot names the same domain (RFC 6265 §5.2.3).
  const domain = (named ?? "").replace(/^\./, "");
  if (domain === "") return null;
  return host === domain || host.endsWith(`.${domain}`) ? domain : null;
}

consentRefreshRoute.get("/", (c) => {
  const domain = cookieDomain(new URL(c.req.url).hostname, c.req.query("domain"));
  const secure = c.req.header("x-forwarded-proto") === "https";
  const cookie = domain === null ? null : consentSetCookie(c.req.header("cookie"), { domain, secure }, Date.now());
  c.header("Cache-Control", "no-store");
  if (cookie !== null) c.header("Set-Cookie", cookie);
  return c.body(null, 204);
});
