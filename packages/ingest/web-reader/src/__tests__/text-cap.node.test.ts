// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Plan §9 row S: a call's answer crosses Workers RPC from the reader object,
 * whose limit is 32 MiB, so the reader gives each page's text at most
 * `floor(24 MiB / urls.length)` UTF-8 bytes, cuts a longer text at a
 * character boundary and marks the page `truncated`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ReadPageResult } from "@breatic/shared";

import { capPageText, perPageTextBytes } from "../text-cap.js";

const MIB = 1024 * 1024;

/**
 * How many UTF-8 bytes a string takes.
 * @param text - The string.
 * @returns Its length in bytes.
 */
function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * A page that read fine with the given text.
 * @param text - Its text.
 * @returns The page.
 */
function okPage(text: string): ReadPageResult {
  return { url: "https://example.com/a", status: "ok", httpStatus: 200, finalUrl: "https://example.com/a", title: "A", kind: "html", text };
}

describe("perPageTextBytes", () => {
  it.each([
    [1, 24 * MIB],
    [2, 12 * MIB],
    [3, 8 * MIB],
    [6, 4 * MIB],
    [20, Math.floor((24 * MIB) / 20)],
  ])("gives each of %i pages floor(24 MiB / n) bytes", (urlCount, expected) => {
    expect(perPageTextBytes(urlCount)).toBe(expected);
  });

  it("keeps every page's share within 24 MiB together", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (urlCount) => {
        const share = perPageTextBytes(urlCount);
        expect(Number.isInteger(share)).toBe(true);
        expect(share * urlCount).toBeLessThanOrEqual(24 * MIB);
        expect((share + 1) * urlCount).toBeGreaterThan(24 * MIB);
      }),
    );
  });
});

describe("capPageText", () => {
  it("leaves a page within the cap untouched and unmarked", () => {
    const page = okPage("Hello 世界");

    const capped = capPageText(page, bytesOf("Hello 世界"));

    expect(capped).toEqual(page);
    expect(capped).not.toHaveProperty("truncated");
  });

  it("cuts a longer ASCII text at the cap and marks the page truncated", () => {
    const capped = capPageText(okPage("abcdefghij"), 4);

    expect(capped).toEqual({ ...okPage("abcd"), truncated: true });
  });

  it("never splits a three-byte character", () => {
    // 中 and 文 are three bytes each; four bytes hold only the first.
    expect(capPageText(okPage("中文"), 4)).toEqual({ ...okPage("中"), truncated: true });
    expect(capPageText(okPage("中文"), 5)).toEqual({ ...okPage("中"), truncated: true });
    expect(capPageText(okPage("中文"), 2)).toEqual({ ...okPage(""), truncated: true });
  });

  it("never splits a surrogate pair", () => {
    // 😀 is four UTF-8 bytes and two UTF-16 units.
    expect(capPageText(okPage("a😀b"), 4)).toEqual({ ...okPage("a"), truncated: true });
    expect(capPageText(okPage("a😀b"), 5)).toEqual({ ...okPage("a😀"), truncated: true });
  });

  it("leaves a page without text untouched", () => {
    const page: ReadPageResult = { url: "https://example.com/gone", status: "unreachable", httpStatus: 404 };

    expect(capPageText(page, 1)).toEqual(page);
  });

  it("keeps the longest whole-character prefix within the cap, for any text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), fc.integer({ min: 0, max: 400 }), (text, maxBytes) => {
        const capped = capPageText(okPage(text), maxBytes);
        const kept = capped.text ?? "";

        expect(text.startsWith(kept)).toBe(true);
        expect(bytesOf(kept)).toBeLessThanOrEqual(maxBytes);
        // Whole characters only: the prefix survives a UTF-8 round trip.
        expect(new TextDecoder().decode(new TextEncoder().encode(kept))).toBe(kept);
        if (bytesOf(text) <= maxBytes) {
          expect(capped).toEqual(okPage(text));
        } else {
          expect(capped.truncated).toBe(true);
          // Longest: the next whole character would not fit.
          const next = String.fromCodePoint(text.codePointAt(kept.length) ?? 0);
          expect(bytesOf(kept) + bytesOf(next)).toBeGreaterThan(maxBytes);
        }
      }),
    );
  });
});
