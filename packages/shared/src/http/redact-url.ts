// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stripping credentials out of a URL before it can reach a log.
 *
 * Some vendors authenticate through the query string rather than a header —
 * Google's image and video endpoints are called as
 * `…/models/{model}:generateContent?key={apiKey}` — so a transport that
 * reports "retrying {url}" hands a live API key to whatever ships the logs.
 *
 * The whole query is dropped rather than matched against a list of
 * sensitive parameter names. A denylist has to be right about every vendor
 * forever, and being wrong once leaks a credential; the origin and path are
 * what an on-call engineer needs to identify the endpoint, and every vendor
 * we call puts the model in the path.
 */

/**
 * Reduce a URL to the parts that are safe to log.
 * @param raw - The request URL, possibly carrying credentials.
 * @returns Origin and path, with any query replaced by a marker.
 */
export function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Never echo an unparseable string back: if it is not a URL we cannot
    // know which part of it was a secret.
    return "<unparseable url>";
  }

  const base = `${parsed.origin}${parsed.pathname}`;
  const hasQuery = parsed.search !== "" || parsed.hash !== "";
  return hasQuery ? `${base}?<redacted>` : base;
}
