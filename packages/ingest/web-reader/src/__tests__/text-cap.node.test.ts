// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Plan §9 row S: a call's answer crosses Workers RPC from the reader object,
 * whose limit is 32 MiB, so the reader gives each page's text at most
 * `floor(8 Mi / urls.length)` UTF-16 code units (the JavaScript string
 * length, which is at most 16 MiB as UTF-16 and 24 MiB as UTF-8), cuts a
 * longer text there, one unit earlier when the cut would split a surrogate
 * pair, and marks the page `truncated`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ReadPageResult } from "@breatic/shared";

import { capPageText, perPageTextUnits } from "../text-cap.js";

/** The code units one call's pages carry together. */
const CALL_UNITS = 8 * 1024 * 1024;

/**
 * A page that read fine with the given text.
 * @param text - Its text.
 * @returns The page.
 */
function okPage(text: string): ReadPageResult {
  return { url: "https://example.com/a", status: "ok", httpStatus: 200, finalUrl: "https://example.com/a", title: "A", kind: "html", text };
}

/**
 * Whether a cut before index `at` lands between a high and a low surrogate.
 * @param text - The string.
 * @param at - Where the cut falls.
 * @returns True when it splits a surrogate pair.
 */
function splitsPairAt(text: string, at: number): boolean {
  const high = text.charCodeAt(at - 1);
  const low = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

describe("perPageTextUnits: each page's share, in code units", () => {
  it.each([
    [1, 8_388_608],
    [2, 4_194_304],
    [3, Math.floor(CALL_UNITS / 3)],
    [6, Math.floor(CALL_UNITS / 6)],
    [20, Math.floor(CALL_UNITS / 20)],
  ])("gives each of %i pages floor(8 Mi / n) code units", (urlCount, expected) => {
    expect(perPageTextUnits(urlCount)).toBe(expected);
  });

  it("keeps every page's share within 8 Mi code units together", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (urlCount) => {
        const share = perPageTextUnits(urlCount);
        expect(Number.isInteger(share)).toBe(true);
        expect(share * urlCount).toBeLessThanOrEqual(CALL_UNITS);
        expect((share + 1) * urlCount).toBeGreaterThan(CALL_UNITS);
      }),
    );
  });
});

describe("capPageText", () => {
  it("leaves a page within the cap untouched and unmarked", () => {
    const page = okPage("Hello 世界");

    const capped = capPageText(page, "Hello 世界".length);

    expect(capped).toEqual(page);
    expect(capped).not.toHaveProperty("truncated");
  });

  it("cuts a longer ASCII text at the cap and marks the page truncated", () => {
    const capped = capPageText(okPage("abcdefghij"), 4);

    expect(capped).toEqual({ ...okPage("abcd"), truncated: true });
  });

  it("cuts a one-page call's text at 8 Mi code units, whatever its UTF-8 size", () => {
    const text = "a".repeat(CALL_UNITS + 10);

    const capped = capPageText(okPage(text), perPageTextUnits(1));

    expect(capped.text?.length).toBe(CALL_UNITS);
    expect(capped.truncated).toBe(true);
  });

  it("counts a CJK character as one unit, so a text of them is cut to exactly the cap", () => {
    const capped = capPageText(okPage("中".repeat(10)), 4);

    expect(capped).toEqual({ ...okPage("中中中中"), truncated: true });
  });

  it("cuts one unit earlier when the cap falls inside a surrogate pair", () => {
    // 😀 is two UTF-16 units; a cap of 2 lands between them.
    expect(capPageText(okPage("a😀b"), 2)).toEqual({ ...okPage("a"), truncated: true });
    expect(capPageText(okPage("a😀b"), 1)).toEqual({ ...okPage("a"), truncated: true });
    expect(capPageText(okPage("a😀b"), 3)).toEqual({ ...okPage("a😀"), truncated: true });
  });

  it("leaves a page without text untouched", () => {
    const page: ReadPageResult = { url: "https://example.com/gone", status: "unreachable", httpStatus: 404 };

    expect(capPageText(page, 1)).toEqual(page);
  });

  it("keeps the longest prefix within the cap that splits no surrogate pair, for any text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), fc.integer({ min: 0, max: 250 }), (text, maxUnits) => {
        const capped = capPageText(okPage(text), maxUnits);
        const kept = capped.text ?? "";

        expect(text.startsWith(kept)).toBe(true);
        expect(kept.length).toBeLessThanOrEqual(maxUnits);
        if (text.length <= maxUnits) {
          expect(capped).toEqual(okPage(text));
        } else {
          expect(capped.truncated).toBe(true);
          const splitsPair = maxUnits > 0 && splitsPairAt(text, maxUnits);
          expect(kept.length).toBe(splitsPair ? maxUnits - 1 : maxUnits);
        }
      }),
    );
  });
});
