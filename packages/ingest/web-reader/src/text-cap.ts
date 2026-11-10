// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How much page text one call's answer may carry (inner#1664): the answer
 * crosses Workers RPC from the reader object, whose limit is 32 MiB. Structured
 * clone sends a string holding any character outside Latin-1 as UTF-16, two
 * bytes a code unit, so the pages share 8 Mi code units (the JavaScript string
 * length) between them: at most 16 MiB on the wire, whatever the language.
 *
 * A page's title and final address come from the site too, so they are held
 * to the contract's own bounds: the title is cut to `READ_PAGE_MAX_TITLE_CHARS`,
 * and a final address longer than `READ_PAGE_MAX_URL_CHARS` is left out.
 */
import { READ_PAGE_MAX_TITLE_CHARS, READ_PAGE_MAX_URL_CHARS } from "@shared/agent/read-pages.js";
import type { ReadPageResult } from "@shared/agent/read-pages.js";

/** The text one call's pages carry together, in UTF-16 code units. */
const CALL_TEXT_UNITS = 8 * 1024 * 1024;

/**
 * Each page's share of the call's text.
 * @param urlCount - How many pages the call reads.
 * @returns The most UTF-16 code units one page's text may take.
 * @throws {never} Never.
 */
export function perPageTextUnits(urlCount: number): number {
  return Math.floor(CALL_TEXT_UNITS / urlCount);
}

/**
 * Cut a string to at most `maxUnits` UTF-16 code units, one unit earlier when
 * the cut would split a surrogate pair.
 * @param text - The string, longer than `maxUnits`.
 * @param maxUnits - The most code units it may take.
 * @returns The cut string.
 */
function cutAt(text: string, maxUnits: number): string {
  const high = text.charCodeAt(maxUnits - 1);
  const low = text.charCodeAt(maxUnits);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(0, splitsPair ? maxUnits - 1 : maxUnits);
}

/**
 * Hold a page to the answer's bounds: its text cut to at most `maxUnits`
 * UTF-16 code units and marked `truncated` when it was cut, its title cut to
 * `READ_PAGE_MAX_TITLE_CHARS`, and a final address past
 * `READ_PAGE_MAX_URL_CHARS` left out.
 * @param page - The page.
 * @param maxUnits - The most code units its text may take.
 * @returns The page, unchanged when everything fits.
 * @throws {never} Never.
 */
export function capPageText(page: ReadPageResult, maxUnits: number): ReadPageResult {
  let capped = page;
  if (capped.title !== undefined && capped.title.length > READ_PAGE_MAX_TITLE_CHARS) {
    capped = { ...capped, title: cutAt(capped.title, READ_PAGE_MAX_TITLE_CHARS) };
  }
  if (capped.finalUrl !== undefined && capped.finalUrl.length > READ_PAGE_MAX_URL_CHARS) {
    const { finalUrl: _dropped, ...rest } = capped;
    capped = rest;
  }
  if (capped.text !== undefined && capped.text.length > maxUnits) {
    capped = { ...capped, text: cutAt(capped.text, maxUnits), truncated: true };
  }
  return capped;
}
