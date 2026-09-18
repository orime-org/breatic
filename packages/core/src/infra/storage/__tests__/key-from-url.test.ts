// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a stored object's key back out of its public URL.
 *
 * One prefix answers both questions a caller has — is this ours, and which
 * object is it. Split across two functions they drift: a base carrying a path
 * or a trailing slash makes `startsWith` and a `slice` disagree, and a key
 * stripped wrong reaches the bucket as a miss nobody can trace.
 */

import { describe, it, expect } from "vitest";
import { S3StorageAdapter, type S3CompatibleConfig } from "@core/infra/storage/s3.js";

/** An adapter reading back from `base`, with the rest of the config inert. */
function adapterFor(base: string): S3StorageAdapter {
  const config: S3CompatibleConfig = {
    bucket: "assets",
    region: "auto",
    accessKeyId: "id",
    secretAccessKey: "secret",
    publicBaseUrl: base,
  };
  return new S3StorageAdapter(config);
}

describe("reading a key back out of a public URL", () => {
  it("answers the key a plain base was joined to", () => {
    const store = adapterFor("https://assets.example.com");

    expect(store.keyFromUrl("https://assets.example.com/image/2026-08-13/a.png")).toBe(
      "image/2026-08-13/a.png",
    );
  });

  it("answers null for a URL under another host", () => {
    const store = adapterFor("https://assets.example.com");

    expect(store.keyFromUrl("https://evil.example.com/image/a.png")).toBeNull();
  });

  it("answers null for a host that merely starts the same", () => {
    const store = adapterFor("https://assets.example.com");

    expect(store.keyFromUrl("https://assets.example.com.evil.test/a.png")).toBeNull();
  });

  it("strips a base that carries a path of its own", () => {
    const store = adapterFor("https://cdn.example.com/assets");

    expect(store.keyFromUrl("https://cdn.example.com/assets/image/a.png")).toBe(
      "image/a.png",
    );
  });

  it("answers null for the base itself, which names no object", () => {
    const store = adapterFor("https://assets.example.com");

    expect(store.keyFromUrl("https://assets.example.com")).toBeNull();
    expect(store.keyFromUrl("https://assets.example.com/")).toBeNull();
  });

  it("round-trips every key publicUrl builds", () => {
    const store = adapterFor("https://assets.example.com");
    const keys = ["a.png", "image/a.png", "image/2026-08-13/17865_0c24.png"];

    for (const key of keys) {
      expect(store.keyFromUrl(store.publicUrl(key))).toBe(key);
    }
  });

});
