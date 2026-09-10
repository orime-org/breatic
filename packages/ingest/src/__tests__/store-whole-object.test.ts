// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storing bytes the Worker already holds (#209 + #210, design §4.2).
 *
 * The cover the media container cuts arrives as bytes in this Worker rather
 * than as an upload, and it becomes a ledger row of its own — so it needs the
 * same two facts every other row keys on: the hash of what is stored, and what
 * it weighs. Both are read back off R2 rather than taken from the buffer in
 * hand, which is the rule every other object here follows.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { storeWholeObject } from "@ingest/stored-object.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

/**
 * The SHA-256 of some bytes, as hex.
 * @param bytes - What to hash.
 * @returns The digest, lowercase.
 */
async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("storing an object whose bytes we hold", () => {
  it("writes them at the key it was given", async () => {
    const key = "image/2026-09-10/whole_written.png";

    await storeWholeObject(env.BUCKET, key, PNG, "image/png");

    const stored = await env.BUCKET.get(key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG);
  });

  it("reports the hash and the size of what landed", async () => {
    const key = "image/2026-09-10/whole_measured.png";

    const measured = await storeWholeObject(env.BUCKET, key, PNG, "image/png");

    expect(measured.sha256).toBe(await sha256Of(PNG));
    expect(measured.sizeBytes).toBe(PNG.byteLength);
  });

  it("stores the content type, which is what a reader is served", async () => {
    const key = "image/2026-09-10/whole_typed.png";

    await storeWholeObject(env.BUCKET, key, PNG, "image/png");

    const stored = await env.BUCKET.head(key);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
  });
});
