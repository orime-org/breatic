// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How much page text one call's answer may carry (inner#1664): the answer
 * crosses Workers RPC from the reader object, whose limit is 32 MiB. Structured
 * clone sends a string holding any character outside Latin-1 as UTF-16, two
 * bytes a code unit, so the pages share 8 Mi code units (the JavaScript string
 * length) between them: at most 16 MiB on the wire, whatever the language.
 */
import type { ReadPageResult } from "@shared/agent/read-pages.js";

/** The text one call's pages carry together, in UTF-16 code units. */
const CALL_TEXT_UNITS = 8 * 1024 * 1024;

/**
 * Each page's share of the call's text.
 * @param urlCount - How many pages the call reads.
 * @returns The most UTF-16 code units one page's text may take.
 * @throws {never} Never.
 */
export function perPageTextBytes(urlCount: number): number {
  return Math.floor(CALL_TEXT_UNITS / urlCount);
}

/**
 * Cut a page's text to at most `maxUnits` UTF-16 code units, one unit earlier
 * when the cut would split a surrogate pair, and mark it `truncated` when it
 * was cut.
 * @param page - The page.
 * @param maxUnits - The most code units its text may take.
 * @returns The page, unchanged when its text fits.
 * @throws {never} Never.
 */
export function capPageText(page: ReadPageResult, maxUnits: number): ReadPageResult {
  const { text } = page;
  if (text === undefined || text.length <= maxUnits) return page;
  const high = text.charCodeAt(maxUnits - 1);
  const low = text.charCodeAt(maxUnits);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return { ...page, text: text.slice(0, splitsPair ? maxUnits - 1 : maxUnits), truncated: true };
}
