// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 *
 * It takes a `URL`, not a string, and that is what lets it be this short. It
 * used to take the raw string, which meant parsing (and failing to parse, and
 * reporting that failure through a sentinel string the caller compared
 * against, and then parsing a second time). One parse now happens at the
 * boundary, and a value that cannot be parsed — or that is not http — never
 * reaches this function at all, because the boundary refuses it first.
 */

/**
 * Reduce a URL to the parts that are safe to log.
 * @param parsed - An http or https URL, already parsed by the caller.
 * @returns Origin and path, with any query or fragment replaced by a marker.
 */
export function redactUrl(parsed: URL): string {
  // Query and fragment are marked separately because they are different
  // things and the log should not claim otherwise: a fragment never reaches
  // the server at all, and reporting `https://host/path#token=x` as
  // `https://host/path?<redacted>` describes a query string that was never
  // sent. Both are still dropped — a fragment sits in the same string we are
  // about to hand to a log, so what it holds matters here even though the
  // server never saw it.
  const marks =
    (parsed.search !== "" ? "?<redacted>" : "") +
    (parsed.hash !== "" ? "#<redacted>" : "");
  return `${parsed.origin}${parsed.pathname}${marks}`;
}
