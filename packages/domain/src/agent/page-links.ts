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
 * longer word or address; a colon may come before it (`site:example.com`),
 * and a JSON escape such as `\n` before it counts as a break, because a
 * document body reaches the model JSON-encoded.
 */
const LINK_START =
  /https?:\/\/|(?<=^|[^A-Za-z0-9.\-_@/%\\]|\\[ntr])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/gi;

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
 * turndown writes for `(`, `)` and `_`, and two backslashes before one are
 * that escape JSON-encoded; before anything else a backslash ends the link.
 */
const URL_PUNCTUATION = new Set("-._~:/?#[]@!$&'()*+,;=%");

/** Marks a sentence puts after a link, which GFM leaves out of an autolink. */
const TRAILING = new Set(".,;:!?*_~");

/** A link as read, with where each of its characters ends in the text it was read from. */
interface ReadLink {
  /** The link, with Markdown escapes removed. */
  link: string;
  /** For each character of `link`, the position in the text right after it, escape included. */
  ends: number[];
  /** Where reading stopped. */
  end: number;
}

/**
 * Read one link from where it starts until a character ends it.
 * @param text - The text.
 * @param from - Where the link starts.
 * @returns The link as read, where each character ends in the text, and
 *   where reading stopped: the whole run, however long, so no part of it is
 *   read again.
 */
function readLink(text: string, from: number): ReadLink {
  let link = "";
  const ends: number[] = [];
  let at = from;
  while (at < text.length) {
    const char = text[at] as string;
    if (char === "\\") {
      const next = text[at + 1];
      const after = text[at + 2];
      if (next === "\\" && after !== undefined && URL_PUNCTUATION.has(after)) {
        link += after;
        at += 3;
        ends.push(at);
        continue;
      }
      if (next === undefined || !URL_PUNCTUATION.has(next)) break;
      link += next;
      at += 2;
      ends.push(at);
      continue;
    }
    if (/\s/u.test(char) || CHINESE_ENDS.has(char) || QUOTE_ENDS.has(char) || NEVER_IN_URL.has(char)) break;
    link += char;
    at += 1;
    ends.push(at);
  }
  return { link, ends, end: at };
}

/**
 * Whether a link, as it would be stored, fits a page address.
 * @param link - The link, with or without its scheme.
 * @param hasScheme - Whether it was written with one; one without is stored with `https://`.
 * @returns True when it is at most `READ_PAGE_MAX_URL_CHARS` long.
 */
function fits(link: string, hasScheme: boolean): boolean {
  return (hasScheme ? link.length : link.length + "https://".length) <= READ_PAGE_MAX_URL_CHARS;
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
 * Drop the punctuation a sentence put after a link: trailing marks, a
 * closing parenthesis that closes nothing opened inside the link (GFM), and
 * a single quote the link holds no other to pair with.
 * @param link - The link as read.
 * @returns The link.
 */
function trimEnd(link: string): string {
  const opens = countOf(link, "(");
  let closes = countOf(link, ")");
  let quotes = countOf(link, "'");
  let end = link.length;
  for (; end > 0; end -= 1) {
    const last = link[end - 1] as string;
    if (TRAILING.has(last)) continue;
    if (last === ")" && closes > opens) {
      closes -= 1;
      continue;
    }
    if (last === "'" && quotes % 2 === 1) {
      quotes -= 1;
      continue;
    }
    break;
  }
  return link.slice(0, end);
}

/**
 * Whether a host written without a scheme goes on into a path, a query, a
 * fragment or a port at a place in the text.
 * @param text - The text.
 * @param at - The character right after the host.
 * @returns True when the link keeps reading there.
 */
function hostGoesOn(text: string, at: number): boolean {
  const char = text[at];
  if (char === "/" || char === "?" || char === "#") return true;
  return char === ":" && /[0-9]/.test(text[at + 1] ?? "");
}

/** A link read from a text, and where the text writes it. */
export interface PageLinkSpan {
  /** The link, as `pageLinksIn` gives it. */
  link: string;
  /** Where it starts in the text. */
  start: number;
  /**
   * Where it ends in the text: right after the last character kept, a
   * Markdown escape's backslash counted, the punctuation `trimEnd` drops not.
   */
  end: number;
}

/**
 * Every link written in a piece of text, in the order they appear, with
 * where the text writes each.
 *
 * A link holding a non-ASCII character is followed by the same link cut at
 * that character: a user who runs a link on into Chinese without a space
 * still has the plain link, and a real non-ASCII path keeps its full spelling.
 * A link longer than `READ_PAGE_MAX_URL_CHARS` once its end is trimmed and,
 * when written without a scheme, `https://` is put in front, is left out; the
 * cut spelling is judged the same way on its own length, and ends before the
 * non-ASCII character it was cut at.
 * @param text - The text.
 * @returns The links, each cleaned of the punctuation around it, with their places.
 * @throws {never} Never.
 */
export function pageLinkSpansIn(text: string): PageLinkSpan[] {
  const spans: PageLinkSpan[] = [];
  const start = new RegExp(LINK_START.source, LINK_START.flags);
  for (let found = start.exec(text); found !== null; found = start.exec(text)) {
    const opening = found[0];
    const hasScheme = /^https?:\/\//i.test(opening);
    const read: ReadLink =
      hasScheme || hostGoesOn(text, found.index + opening.length)
        ? readLink(text, found.index)
        : {
            link: opening,
            ends: Array.from({ length: opening.length }, (_, i) => found.index + i + 1),
            end: found.index + opening.length,
          };
    start.lastIndex = Math.max(read.end, found.index + 1);
    /**
     * The span of the read link's first `length` characters, its end trimmed.
     * @param length - How many characters of the link to take.
     * @returns The span, or undefined when nothing is left.
     */
    const spanOf = (length: number): PageLinkSpan | undefined => {
      const link = trimEnd(read.link.slice(0, length));
      const end = read.ends[link.length - 1];
      return end === undefined ? undefined : { link, start: found.index, end };
    };
    const whole = spanOf(read.link.length);
    if (whole === undefined || (hasScheme && whole.link.length <= opening.length)) continue;
    if (fits(whole.link, hasScheme)) spans.push(whole);
    const nonAscii = whole.link.search(/[\u0080-\u{10FFFF}]/u);
    const cut = nonAscii < 0 ? undefined : spanOf(nonAscii);
    if (cut !== undefined && (!hasScheme || cut.link.length > opening.length) && fits(cut.link, hasScheme)) {
      spans.push(cut);
    }
  }
  return spans;
}

/**
 * Every link written in a piece of text, in the order they appear: the links
 * of `pageLinkSpansIn`.
 * @param text - The text.
 * @returns The links, each cleaned of the punctuation around it.
 * @throws {never} Never.
 */
export function pageLinksIn(text: string): string[] {
  return pageLinkSpansIn(text).map((span) => span.link);
}
