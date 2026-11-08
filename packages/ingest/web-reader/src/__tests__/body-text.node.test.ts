// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Plan §13.1: how the page reader turns a body that is not HTML into text.
 *
 * `recoverUtf8` undoes Chromium's fallback for a text body whose response
 * named no charset: Chromium decodes it as windows-1252, so UTF-8 text such
 * as Chinese arrives garbled; turned back into the windows-1252 bytes and
 * decoded as strict UTF-8 it is the text the site sent.
 *
 * `textOfDownload` reads a file Chromium turned into a download (a CSV, a
 * text/plain body whose first bytes look binary) as text when its response
 * names a text type, in the charset it names, UTF-8 when it names none.
 */

import { describe, expect, it } from "vitest";

import { recoverUtf8, textOfDownload } from "../body-text.js";

const CHINESE = "中文网页 café";

/**
 * A UTF-8 text as Chromium shows it when it falls back to windows-1252.
 * @param text - The text the site sent.
 * @returns The garbled text.
 */
function asWindows1252(text: string): string {
  return new TextDecoder("windows-1252").decode(new TextEncoder().encode(text));
}

describe("recoverUtf8", () => {
  it("recovers UTF-8 text Chromium decoded as windows-1252 for a response that named no charset", () => {
    const garbled = asWindows1252(CHINESE);
    expect(garbled).not.toBe(CHINESE);

    expect(recoverUtf8(garbled, "text/plain", "windows-1252")).toBe(CHINESE);
    expect(recoverUtf8(garbled, null, "windows-1252")).toBe(CHINESE);
  });

  it("leaves the text alone when the response named a charset", () => {
    const garbled = asWindows1252(CHINESE);

    expect(recoverUtf8(garbled, "text/plain; charset=windows-1252", "windows-1252")).toBe(garbled);
  });

  it("leaves the text alone when Chromium did not fall back to windows-1252", () => {
    expect(recoverUtf8(CHINESE, "text/plain", "UTF-8")).toBe(CHINESE);
  });

  it("leaves real windows-1252 text alone, whose bytes are not UTF-8", () => {
    // "caf" and 0xE9: e-acute in windows-1252, a broken sequence in UTF-8.
    const latin = new TextDecoder("windows-1252").decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));

    expect(recoverUtf8(latin, "text/plain", "windows-1252")).toBe(latin);
  });
});

describe("textOfDownload", () => {
  it("reads a CSV as the text it holds", () => {
    const csv = "name,city\nAda,London\n";

    expect(textOfDownload(new TextEncoder().encode(csv), "text/csv; charset=utf-8")).toBe(csv);
  });

  it("decodes in the charset the response names", () => {
    // Four Chinese characters in GBK.
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);

    expect(textOfDownload(gbk, "text/plain; charset=gbk")).toBe("中文测试");
  });

  it("decodes as UTF-8 when the response names no charset", () => {
    expect(textOfDownload(new TextEncoder().encode(CHINESE), "text/plain")).toBe(CHINESE);
  });

  it("decodes as UTF-8 when the named charset is not one there is a decoder for", () => {
    expect(textOfDownload(new TextEncoder().encode(CHINESE), "text/plain; charset=no-such-charset")).toBe(CHINESE);
  });

  it.each(["application/rss+xml", "application/json", "application/ld+json", "application/xml"])(
    "reads a download of type %s as text",
    (contentType) => {
      expect(textOfDownload(new TextEncoder().encode("<rss/>"), contentType)).toBe("<rss/>");
    },
  );

  it.each([["application/zip"], ["application/octet-stream"], ["image/png"], ["image/svg+xml"], [null]])(
    "reads nothing from a download of type %s",
    (contentType) => {
      expect(textOfDownload(new TextEncoder().encode("bytes"), contentType)).toBeNull();
    },
  );
});
