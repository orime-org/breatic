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

  // `origin + pathname` is an http-shaped assumption, and it fails loudly off
  // that shape: a `data:` URL parses fine, has origin `"null"`, and carries its
  // whole payload in the pathname — so the redaction that hides `?key=` hands a
  // `data:` payload straight back. Measured: `data:text/plain,SECRET` used to
  // come out as `nulltext/plain,SECRET`.
  //
  // This is reachable rather than theoretical. The agent's fetch tool takes a
  // URL from the model; the SSRF guard rejects the non-http scheme; and the
  // transport then redacts that same URL for the event it emits on the way out.
  // The guard stops the REQUEST — it does not stop the string reaching a log.
  // The scheme is the only part safe to name, so it is the only part named.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `<non-http url: ${parsed.protocol}>`;
  }

  // Query and fragment are marked separately because they are different
  // things and the log should not claim otherwise: a fragment never reaches
  // the server at all, and reporting `https://host/path#token=x` as
  // `https://host/path?<redacted>` describes a query string that was never
  // sent. Both are still dropped — a fragment sits in the same string we are
  // about to hand to a log, so what it holds matters here even though the
  // server never saw it.
  const base = `${parsed.origin}${parsed.pathname}`;
  const marks =
    (parsed.search !== "" ? "?<redacted>" : "") +
    (parsed.hash !== "" ? "#<redacted>" : "");
  return `${base}${marks}`;
}
