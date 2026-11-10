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
 * names a text type, in the charset it names; when it names none, by its byte
 * order mark, then as strict UTF-8, then as windows-1252.
 */

import { describe, expect, it } from "vitest";

import { isMediaType, isTextType, recoverUtf8, textOfDownload } from "../body-text.js";

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

// Plan §14 row 10: a download that names no charset is read by its BOM, then
// as strict UTF-8, then as windows-1252.
describe("textOfDownload with no charset named", () => {
  it("drops a UTF-8 byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CHINESE)]);

    expect(textOfDownload(bytes, "text/csv")).toBe(CHINESE);
  });

  it("decodes UTF-16LE after its byte order mark", () => {
    const units = [...CHINESE].flatMap((char) => {
      const code = char.charCodeAt(0);
      return [code & 0xff, code >> 8];
    });

    expect(textOfDownload(new Uint8Array([0xff, 0xfe, ...units]), "text/plain")).toBe(CHINESE);
  });

  it("decodes UTF-16BE after its byte order mark", () => {
    const units = [...CHINESE].flatMap((char) => {
      const code = char.charCodeAt(0);
      return [code >> 8, code & 0xff];
    });

    expect(textOfDownload(new Uint8Array([0xfe, 0xff, ...units]), "text/plain")).toBe(CHINESE);
  });

  it("falls back to windows-1252 for bytes that are not UTF-8", () => {
    // "Z\xfcrich,caf\xe9" in latin1.
    const bytes = new Uint8Array([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68, 0x2c, 0x63, 0x61, 0x66, 0xe9]);

    expect(textOfDownload(bytes, "text/csv")).toBe("Z\u00fcrich,caf\u00e9");
  });

  it("still reads UTF-8 as UTF-8", () => {
    expect(textOfDownload(new TextEncoder().encode(CHINESE), "text/csv")).toBe(CHINESE);
  });
});

// Plan §14 row 12: scripts, YAML and line-delimited JSON are text too.
describe("isTextType", () => {
  it.each([
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/yaml",
    "application/x-yaml",
    "application/x-ndjson",
    "application/jsonl",
  ])("counts %s as text", (type) => {
    expect(isTextType(type)).toBe(true);
  });

  it.each(["text/plain", "application/json", "application/rss+xml"])("still counts %s as text", (type) => {
    expect(isTextType(type)).toBe(true);
  });

  it.each(["image/svg+xml", "application/zip", "application/octet-stream"])("does not count %s as text", (type) => {
    expect(isTextType(type)).toBe(false);
  });
});

// Plan §14 row 14: one test of what a media type is, for the server and the
// classifier both.
describe("isMediaType", () => {
  it.each(["image/png", "image/svg+xml", "audio/mpeg", "video/mp4"])("counts %s as media", (type) => {
    expect(isMediaType(type)).toBe(true);
  });

  it.each(["text/plain", "application/json", "application/pdf", "application/octet-stream", ""])(
    "does not count %j as media",
    (type) => {
      expect(isMediaType(type)).toBe(false);
    },
  );
});
