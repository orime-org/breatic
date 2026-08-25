// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Content-sniffing unit tests (#1826, design §4.2) — the backend-authoritative
 * MIME derivation that fixes #1825 (local storage hardcoded octet-stream →
 * every local upload's kind was 'file').
 *
 * Two layers:
 *   1. magic-bytes (file-type) for binary formats with a signature;
 *   2. content-aware fallback for signature-less formats (SVG is XML text,
 *      CSV/JSON/TXT are plain text) — file-type returns undefined for these,
 *      and we must NOT fall back to octet-stream (that reproduces #1825) nor
 *      reject: SVG → image/svg+xml, plain text → text/plain, and only a truly
 *      binary blob (WHATWG binary-data byte present) → octet-stream.
 */

import { describe, it, expect } from "vitest";
import { sniffMimeType } from "@core/infra/storage/sniff-mime.js";

/** Concatenate byte arrays / strings into one Buffer. */
function bytes(...parts: Array<number[] | string>): Uint8Array {
  return Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p) : Buffer.from(p))),
  );
}

describe("sniffMimeType — magic-bytes (binary signatures)", () => {
  it("detects PNG", async () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    expect(await sniffMimeType(png)).toBe("image/png");
  });

  it("detects JPEG", async () => {
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    expect(await sniffMimeType(jpeg)).toBe("image/jpeg");
  });

  it("detects GIF", async () => {
    expect(await sniffMimeType(bytes("GIF89a"))).toBe("image/gif");
  });

  it("detects WEBP", async () => {
    const webp = bytes("RIFF", [0x1a, 0x00, 0x00, 0x00], "WEBPVP8 ");
    expect(await sniffMimeType(webp)).toBe("image/webp");
  });

  it("detects MP4", async () => {
    const mp4 = bytes([0x00, 0x00, 0x00, 0x18], "ftyp", "mp42", [0x00, 0x00, 0x00, 0x00], "mp42isom");
    expect(await sniffMimeType(mp4)).toBe("video/mp4");
  });
});

describe("sniffMimeType — content-aware fallback (no signature)", () => {
  it("classifies a bare <svg> as image/svg+xml (NOT octet-stream / #1825)", async () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    expect(await sniffMimeType(svg)).toBe("image/svg+xml");
  });

  it("classifies an <?xml?>-prefixed SVG as image/svg+xml", async () => {
    const svg = bytes('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await sniffMimeType(svg)).toBe("image/svg+xml");
  });

  it("classifies SVG with leading whitespace / BOM", async () => {
    const svg = bytes([0xef, 0xbb, 0xbf], "  \n<svg viewBox='0 0 1 1'></svg>");
    expect(await sniffMimeType(svg)).toBe("image/svg+xml");
  });

  it("classifies CSV as text/plain (→ detectKind document, NOT file)", async () => {
    expect(await sniffMimeType(bytes("name,age\nalice,30\nbob,25\n"))).toBe("text/plain");
  });

  it("classifies plain text as text/plain", async () => {
    expect(await sniffMimeType(bytes("just some human-readable notes here"))).toBe("text/plain");
  });

  it("classifies JSON as text/plain", async () => {
    expect(await sniffMimeType(bytes('{"a":1,"b":[2,3],"c":"x"}'))).toBe("text/plain");
  });

  it("classifies non-SVG XML as text/plain (an <?xml?> without <svg>)", async () => {
    expect(await sniffMimeType(bytes('<?xml version="1.0"?><rss><channel/></rss>'))).toBe("text/plain");
  });
});

describe("sniffMimeType — genuinely binary → octet-stream", () => {
  it("returns octet-stream for a blob with a WHATWG binary-data byte (NUL)", async () => {
    const blob = bytes([0x00, 0x01, 0x02, 0xff, 0x00, 0x13, 0x42, 0x99]);
    expect(await sniffMimeType(blob)).toBe("application/octet-stream");
  });

  it("returns octet-stream for an empty buffer", async () => {
    expect(await sniffMimeType(bytes())).toBe("application/octet-stream");
  });
});
