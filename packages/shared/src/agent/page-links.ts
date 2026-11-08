// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links a conversation holds, and the one key two spellings of a link
 * are compared by (inner#1664).
 *
 * Both sides read links the same way: the server decides which pages the
 * Agent may read, and the panel merges two sources that name one page.
 */

/**
 * Where a link may start: a scheme, or a host written without one.
 *
 * A host has a top-level label of two or more letters, so `1.2` and `file.c`
 * are not hosts. It may not follow a character that would make it part of a
 * longer word or address; a JSON escape such as `\n` before it counts as a
 * break, because a document body reaches the model JSON-encoded.
 */
const LINK_START =
  /https?:\/\/|(?<=^|[^A-Za-z0-9.\-_@/:%\\]|\\[ntr])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/gi;

/** Chinese punctuation that ends a link. */
const CHINESE_ENDS = new Set("，。、；：！？）》」』】");

/** Characters RFC 3986 never allows unencoded, which end a link. */
const NEVER_IN_URL = new Set('"<>`{}|^');

/**
 * The ASCII punctuation a URL may hold (RFC 3986 reserved and unreserved
 * marks, and `%`). A backslash before one of them is a Markdown escape, which
 * turndown writes for `(`, `)` and `_`; before anything else it ends the link.
 */
const URL_PUNCTUATION = new Set("-._~:/?#[]@!$&'()*+,;=%");

/** Marks a sentence puts after a link, which GFM leaves out of an autolink. */
const TRAILING = new Set(".,;:!?*_~");

/**
 * Read one link from where it starts until a character ends it.
 * @param text - The text.
 * @param from - Where the link starts.
 * @returns The link as read, with Markdown escapes removed, and where reading stopped.
 */
function readLink(text: string, from: number): { link: string; end: number } {
  let link = "";
  let at = from;
  while (at < text.length) {
    const char = text[at] as string;
    if (char === "\\") {
      const next = text[at + 1];
      if (next === undefined || !URL_PUNCTUATION.has(next)) break;
      link += next;
      at += 2;
      continue;
    }
    if (/\s/u.test(char) || CHINESE_ENDS.has(char) || NEVER_IN_URL.has(char)) break;
    link += char;
    at += 1;
  }
  return { link, end: at };
}

/**
 * Drop the punctuation a sentence put after a link: trailing marks, and a
 * closing parenthesis that closes nothing opened inside the link (GFM).
 * @param link - The link as read.
 * @returns The link.
 */
function trimEnd(link: string): string {
  let out = link;
  for (;;) {
    const last = out.at(-1);
    if (last !== undefined && TRAILING.has(last)) {
      out = out.slice(0, -1);
    } else if (last === ")" && out.split(")").length > out.split("(").length) {
      out = out.slice(0, -1);
    } else {
      return out;
    }
  }
}

/**
 * Every link written in a piece of text, in the order they appear.
 * @param text - The text.
 * @returns The links, each cleaned of the punctuation around it.
 * @throws {never} Never.
 */
export function pageLinksIn(text: string): string[] {
  const links: string[] = [];
  const start = new RegExp(LINK_START.source, LINK_START.flags);
  for (let found = start.exec(text); found !== null; found = start.exec(text)) {
    const opening = found[0];
    const hasScheme = /^https?:\/\//i.test(opening);
    let link: string;
    let end: number;
    if (hasScheme || text[found.index + opening.length] === "/") {
      ({ link, end } = readLink(text, found.index));
    } else {
      link = opening;
      end = found.index + opening.length;
    }
    link = trimEnd(link);
    if (!hasScheme || link.length > opening.length) links.push(link);
    start.lastIndex = Math.max(end, found.index + 1);
  }
  return links;
}

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
 * The key two spellings of one page share: host lower-cased, no scheme, no
 * fragment, no trailing slash, the path percent-decoded, the query kept.
 * @param link - A link, with or without its scheme.
 * @returns The key.
 * @throws {never} Never.
 */
export function pageLinkKey(link: string): string {
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
