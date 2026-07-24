// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Cover-resolution unit tests (#1824) — the server derives a video's cover
 * thumbnail URL from a client-supplied, SERVER-VERIFIED reference (cover_key
 * on the regular path / cover_hash on the dedup path), asserts it is an
 * image via the storageKey taskType segment (NOT head().contentType and NOT
 * the ledger stored kind — both unreliable on local storage), and is
 * best-effort: ANY failure yields `undefined` (→ Film) and never throws, so
 * a cover problem can never fail the video upload.
 */

import { describe, it, expect, vi } from "vitest";

import { kindFromStorageKey, resolveCoverUrl } from "../cover-resolve.js";

describe("kindFromStorageKey", () => {
  it("returns the taskType segment (index 2) of a {userId}/{projectId}/{kind}/… key", () => {
    expect(kindFromStorageKey("u1/p1/image/2026-01/x.jpg")).toBe("image");
    expect(kindFromStorageKey("u1/p1/video/x.mp4")).toBe("video");
    expect(kindFromStorageKey("u1/p1/tts/x.mp3")).toBe("tts");
  });

  it("returns undefined for a key with fewer than 3 segments", () => {
    expect(kindFromStorageKey("u1/p1")).toBeUndefined();
    expect(kindFromStorageKey("")).toBeUndefined();
  });
});

const OWNED = (key: string): boolean => key.startsWith("u1/p1/");

/** Default deps: an owned image cover_key that exists in storage. */
function deps(over: Partial<Parameters<typeof resolveCoverUrl>[1]> = {}) {
  return {
    isOwnedKey: OWNED,
    head: vi.fn(async () => ({ exists: true })),
    publicUrl: (key: string) => `https://cdn/${key}`,
    verifyDedupUpload: vi.fn(async () => null),
    ...over,
  };
}

const CTX = { projectId: "p1", actingUserId: "u1" };

describe("resolveCoverUrl — regular path (cover_key)", () => {
  it("returns the server-derived publicUrl for an owned, existing, image cover_key", async () => {
    const url = await resolveCoverUrl({ ...CTX, coverKey: "u1/p1/image/c.jpg" }, deps());
    expect(url).toBe("https://cdn/u1/p1/image/c.jpg");
  });

  it("returns undefined when the cover_key is not owned (cross-user / traversal)", async () => {
    const url = await resolveCoverUrl({ ...CTX, coverKey: "other/p1/image/c.jpg" }, deps());
    expect(url).toBeUndefined();
  });

  it("returns undefined when the object does not exist in storage", async () => {
    const url = await resolveCoverUrl(
      { ...CTX, coverKey: "u1/p1/image/c.jpg" },
      deps({ head: vi.fn(async () => ({ exists: false })) }),
    );
    expect(url).toBeUndefined();
  });

  it("returns undefined when the key's taskType segment is not image (kind confusion)", async () => {
    const url = await resolveCoverUrl({ ...CTX, coverKey: "u1/p1/video/c.mp4" }, deps());
    expect(url).toBeUndefined();
  });
});

describe("resolveCoverUrl — dedup path (cover_hash)", () => {
  it("returns the server-vouched fileUrl when the deduped asset's storageKey segment is image", async () => {
    const url = await resolveCoverUrl(
      { ...CTX, coverHash: "a".repeat(64) },
      deps({
        verifyDedupUpload: vi.fn(async () => ({
          fileUrl: "https://cdn/existing.jpg",
          storageKey: "u1/p1/image/existing.jpg",
          kind: "file", // ledger kind is unreliable on local; MUST be ignored
        })),
      }),
    );
    expect(url).toBe("https://cdn/existing.jpg");
  });

  it("returns undefined when the deduped asset's storageKey segment is NOT image", async () => {
    const url = await resolveCoverUrl(
      { ...CTX, coverHash: "a".repeat(64) },
      deps({
        verifyDedupUpload: vi.fn(async () => ({
          fileUrl: "https://cdn/clip.mp4",
          storageKey: "u1/p1/video/clip.mp4",
          kind: "image", // even if stored kind lies 'image', the key segment wins
        })),
      }),
    );
    expect(url).toBeUndefined();
  });

  it("returns undefined when no dedup row exists", async () => {
    const url = await resolveCoverUrl(
      { ...CTX, coverHash: "a".repeat(64) },
      deps({ verifyDedupUpload: vi.fn(async () => null) }),
    );
    expect(url).toBeUndefined();
  });
});

describe("resolveCoverUrl — best-effort (never throws, always degrades to undefined)", () => {
  it("returns undefined when neither cover_key nor cover_hash is supplied", async () => {
    const url = await resolveCoverUrl({ ...CTX }, deps());
    expect(url).toBeUndefined();
  });

  it("swallows a thrown head() transport error → undefined (does not propagate)", async () => {
    const url = await resolveCoverUrl(
      { ...CTX, coverKey: "u1/p1/image/c.jpg" },
      deps({
        head: vi.fn(async () => {
          throw new Error("S3 transport error");
        }),
      }),
    );
    expect(url).toBeUndefined();
  });

  it("swallows a thrown verifyDedupUpload error (NotFoundError / DB error) → undefined", async () => {
    const url = await resolveCoverUrl(
      { ...CTX, coverHash: "a".repeat(64) },
      deps({
        verifyDedupUpload: vi.fn(async () => {
          throw new Error("Project not found");
        }),
      }),
    );
    expect(url).toBeUndefined();
  });
});
