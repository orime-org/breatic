// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links a piece of text holds (inner#1664).
 *
 * The server builds the set of links the Agent may read from these, and
 * `web_fetch` lists the links of each page it reads. Two spellings of one
 * link are compared by `pageLinkKey` in `@breatic/shared`, which the chat
 * panel shares. The server reads this module through its own entry,
 * `@breatic/domain/page-links`.
 */
import { READ_PAGE_MAX_URL_CHARS } from "@breatic/shared";

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

/**
 * Chinese punctuation that ends a link: the full-width comma, full stop,
 * enumeration comma, semicolon, colon, exclamation and question marks, and
 * the closing parenthesis, double angle bracket, corner brackets and lenticular
 * bracket.
 */
const CHINESE_ENDS = new Set("\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u300B\u300D\u300F\u3011");

/** Curly quotes and the ellipsis, which end a link in any language. */
const QUOTE_ENDS = new Set("\u201C\u201D\u2018\u2019\u2026");

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
 * @returns The link as read, with Markdown escapes removed, or null when it
 *   ran past `READ_PAGE_MAX_URL_CHARS`; and where reading stopped.
 */
function readLink(text: string, from: number): { link: string | null; end: number } {
  let link = "";
  let at = from;
  while (at < text.length) {
    // Longer than any page address may be: dropped, the rest left unread.
    if (link.length > READ_PAGE_MAX_URL_CHARS) return { link: null, end: at };
    const char = text[at] as string;
    if (char === "\\") {
      const next = text[at + 1];
      if (next === undefined || !URL_PUNCTUATION.has(next)) break;
      link += next;
      at += 2;
      continue;
    }
    if (/\s/u.test(char) || CHINESE_ENDS.has(char) || QUOTE_ENDS.has(char) || NEVER_IN_URL.has(char)) break;
    link += char;
    at += 1;
  }
  return { link: link.length > READ_PAGE_MAX_URL_CHARS ? null : link, end: at };
}

/**
 * Count how often a character appears in a string.
 * @param text - The string.
 * @param char - The character.
 * @returns The count.
 */
function countOf(text: string, char: string): number {
  let count = 0;
  for (const c of text) if (c === char) count += 1;
  return count;
}

/**
 * Drop the punctuation a sentence put after a link: trailing marks, and a
 * closing parenthesis that closes nothing opened inside the link (GFM).
 * @param link - The link as read.
 * @returns The link.
 */
function trimEnd(link: string): string {
  const opens = countOf(link, "(");
  let closes = countOf(link, ")");
  let end = link.length;
  for (; end > 0; end -= 1) {
    const last = link[end - 1] as string;
    if (TRAILING.has(last)) continue;
    if (last === ")" && closes > opens) {
      closes -= 1;
      continue;
    }
    break;
  }
  return link.slice(0, end);
}

/**
 * Every link written in a piece of text, in the order they appear.
 *
 * A link holding a non-ASCII character is followed by the same link cut at
 * that character: a user who runs a link on into Chinese without a space
 * still has the plain link, and a real non-ASCII path keeps its full spelling.
 * A link longer than `READ_PAGE_MAX_URL_CHARS` is left out.
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
    let link: string | null;
    let end: number;
    if (hasScheme || text[found.index + opening.length] === "/") {
      ({ link, end } = readLink(text, found.index));
    } else {
      link = opening;
      end = found.index + opening.length;
    }
    start.lastIndex = Math.max(end, found.index + 1);
    if (link === null) continue;
    link = trimEnd(link);
    if (!hasScheme || link.length > opening.length) {
      links.push(link);
      const nonAscii = link.search(/[\u0080-\u{10FFFF}]/u);
      const cut = nonAscii < 0 ? "" : trimEnd(link.slice(0, nonAscii));
      if (cut !== "" && (!hasScheme || cut.length > opening.length)) links.push(cut);
    }
  }
  return links;
}
