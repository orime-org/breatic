// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How much page text one call's answer may carry (inner#1664): the answer
 * crosses Workers RPC from the reader object, whose limit is 32 MiB, so the
 * pages share 24 MiB of text between them.
 */
import type { ReadPageResult } from "@shared/agent/read-pages.js";

/** The text one call's pages carry together, in UTF-8 bytes. */
const CALL_TEXT_BYTES = 24 * 1024 * 1024;

/**
 * Each page's share of the call's text.
 * @param urlCount - How many pages the call reads.
 * @returns The most UTF-8 bytes one page's text may take.
 * @throws {never} Never.
 */
export function perPageTextBytes(urlCount: number): number {
  return Math.floor(CALL_TEXT_BYTES / urlCount);
}

/**
 * Cut a page's text to at most `maxBytes` UTF-8 bytes, at a character
 * boundary, and mark it `truncated` when it was cut.
 * @param page - The page.
 * @param maxBytes - The most bytes its text may take.
 * @returns The page, unchanged when its text fits.
 * @throws {never} Never.
 */
export function capPageText(page: ReadPageResult, maxBytes: number): ReadPageResult {
  if (page.text === undefined) return page;
  // encodeInto writes whole characters only, so `read` ends at a boundary.
  const { read } = new TextEncoder().encodeInto(page.text, new Uint8Array(maxBytes));
  if (read >= page.text.length) return page;
  return { ...page, text: page.text.slice(0, read), truncated: true };
}
