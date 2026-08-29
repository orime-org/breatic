// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * LocalStorageAdapter.head() authoritative-type wiring (#1826, design §4.2;
 * fixes #1825). Confirms head() actually reads the stored bytes and sniffs a
 * real content type instead of the old hardcoded `application/octet-stream`
 * (which made every local upload's kind 'file'). The byte→MIME logic itself is
 * covered exhaustively by sniff-mime.test.ts; this pins the adapter wiring end
 * to end: upload real bytes → head → the sniffed type comes back.
 */

import { describe, it, expect, afterAll } from "vitest";
import { rmSync } from "node:fs";
import crypto from "node:crypto";
import { LocalStorageAdapter } from "@core/infra/storage/local.js";

const adapter = new LocalStorageAdapter();
const TEST_PREFIX = "__test_head__";

/** Concatenate byte arrays / strings into one Buffer. */
function bytes(...parts: Array<number[] | string>): Buffer {
  return Buffer.concat(parts.map((p) => Buffer.from(p as never)));
}

/** Upload a buffer under a fresh key and head it back. */
async function roundTrip(buf: Buffer, ext: string): Promise<{ contentType: string; exists: boolean; size: number }> {
  const key = `${TEST_PREFIX}/${crypto.randomUUID()}${ext}`;
  await adapter.upload(key, buf, "application/octet-stream");
  return adapter.head(key);
}

afterAll(() => {
  // Remove the whole test subtree from the real upload dir.
  rmSync(adapter.getFilePath(TEST_PREFIX), { recursive: true, force: true });
});

describe("LocalStorageAdapter.head — backend-authoritative type (#1825 fix)", () => {
  it("uses the same-origin uploads path when no CDN base URL is configured", () => {
    const sameOriginAdapter = new LocalStorageAdapter({ uploadBaseUrl: "" });
    expect(sameOriginAdapter.publicUrl("image/example.png")).toBe("/uploads/image/example.png");
    expect(sameOriginAdapter.isOwnUrl("/uploads/image/example.png")).toBe(true);
  });

  it("a local PNG heads as image/png (NOT octet-stream)", async () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const head = await roundTrip(png, ".png");
    expect(head.exists).toBe(true);
    expect(head.contentType).toBe("image/png");
    expect(head.size).toBe(png.length);
  });

  it("a local JPEG heads as image/jpeg", async () => {
    const head = await roundTrip(bytes([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]), ".jpg");
    expect(head.contentType).toBe("image/jpeg");
  });

  it("a local SVG heads as image/svg+xml (content-aware, not 'file')", async () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await roundTrip(svg, ".svg")).contentType).toBe("image/svg+xml");
  });

  it("a local CSV heads as text/plain (→ document, not 'file')", async () => {
    expect((await roundTrip(bytes("a,b,c\n1,2,3\n"), ".csv")).contentType).toBe("text/plain");
  });

  it("a genuinely binary blob heads as octet-stream", async () => {
    const blob = bytes([0x00, 0x01, 0x02, 0xff, 0x13, 0x00]);
    expect((await roundTrip(blob, ".bin")).contentType).toBe("application/octet-stream");
  });

  it("a missing key heads as exists:false", async () => {
    const head = await adapter.head(`${TEST_PREFIX}/does-not-exist-${crypto.randomUUID()}.png`);
    expect(head.exists).toBe(false);
    expect(head.contentType).toBe("");
  });
});
