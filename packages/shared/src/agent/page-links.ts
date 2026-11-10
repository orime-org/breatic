// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one key two spellings of a link are compared by (inner#1664).
 *
 * Both sides compare links the same way: the server matches a link the model
 * asks for against the ones the conversation holds, and the panel merges two
 * sources that name one page. Reading links out of text is `pageLinksIn` in
 * `@breatic/domain`.
 */

/**
 * Decode a percent-encoded path, keeping it as written when it does not decode.
 * @param path - The path.
 * @returns The decoded path.
 */
function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * A Markdown escape inside a link: one backslash before URL punctuation, as
 * turndown writes it, or two, as a JSON-encoded body carries it.
 */
const MARKDOWN_ESCAPE = /\\{1,2}([-._~:/?#[\]@!$&'()*+,;=%])/g;

/**
 * The key two spellings of one page share: Markdown escapes removed, host
 * lower-cased, no scheme, no fragment, no trailing slash, the path
 * percent-decoded, the query kept.
 * @param written - A link, with or without its scheme.
 * @returns The key.
 * @throws {never} Never.
 */
export function pageLinkKey(written: string): string {
  const link = written.replace(MARKDOWN_ESCAPE, "$1");
  const withScheme = /^https?:\/\//i.test(link) ? link : `https://${link}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return link.replace(/^https?:\/\//i, "").replace(/#.*$/, "");
  }
  const path = decoded(url.pathname).replace(/\/+$/, "");
  return `${url.host.toLowerCase()}${path}${url.search}`;
}
