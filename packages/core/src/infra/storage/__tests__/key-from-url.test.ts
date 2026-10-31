// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a stored object's key back out of its public URL.
 *
 * One URL parser identifies the configured origin and base path, then returns
 * the object key used by source authorization and re-hosting decisions.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
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

  it.each([
    "https://ASSETS.EXAMPLE.COM/image/a.png",
    "https://assets.example.com:443/image/a.png",
    "https://ASSETS.EXAMPLE.COM:443/image/a.png?download=1#preview",
    "https://assets.example.com/image/a.png?download=1",
    "https://assets.example.com/image/a.png#preview",
  ])("reads the same object key from the equivalent URL %s", (url) => {
    const store = adapterFor("https://assets.example.com");

    expect(store.keyFromUrl(url)).toBe("image/a.png");
  });

  it("compares the configured origin with the same URL semantics", () => {
    const store = adapterFor("https://ASSETS.EXAMPLE.COM:443/assets");

    expect(store.keyFromUrl("https://assets.example.com/assets/image/a.png")).toBe("image/a.png");
  });

  it.each([
    "http://assets.example.com/image/a.png",
    "https://assets.example.com:444/image/a.png",
    "https://assets.example.com.evil.test/image/a.png",
    "https://assets.example.com@evil.test/image/a.png",
    "not a URL",
    "https://[invalid/image/a.png",
    "/image/a.png",
  ])("answers null for a different origin or malformed URL %s", (url) => {
    const store = adapterFor("https://assets.example.com");

    expect(store.keyFromUrl(url)).toBeNull();
  });

  it("keeps the configured base path on its segment boundary", () => {
    const store = adapterFor("https://cdn.example.com/assets");

    expect(store.keyFromUrl("https://CDN.EXAMPLE.COM:443/assets/image/a.png?download=1#preview")).toBe("image/a.png");
    expect(store.keyFromUrl("https://cdn.example.com/assets-other/image/a.png")).toBeNull();
    expect(store.keyFromUrl("https://cdn.example.com/elsewhere/image/a.png")).toBeNull();
    expect(store.keyFromUrl("https://cdn.example.com/assets?download=1")).toBeNull();
    expect(store.keyFromUrl("https://cdn.example.com/assets/#preview")).toBeNull();
  });

  it.each(["https://assets.example.com/", "https://assets.example.com/assets/"])("round-trips the existing public URL spelling for trailing-slash base %s", (base) => {
    const store = adapterFor(base);
    const key = "image/a.png";

    expect(store.publicUrl(key)).toBe(`${base}/${key}`);
    expect(store.keyFromUrl(store.publicUrl(key))).toBe(key);
    expect(store.keyFromUrl(`${store.publicUrl(key)}?download=1#preview`)).toBe(key);
  });

  it("keeps percent and plus characters in the stored key", () => {
    const store = adapterFor("https://assets.example.com");

    for (const key of ["image/a%20b.png", "image/a+b.png", "image/literal%.png"]) {
      expect(store.keyFromUrl(store.publicUrl(key))).toBe(key);
      expect(store.keyFromUrl(`${store.publicUrl(key)}?download=1#preview`)).toBe(key);
    }
  });

  it("preserves generated object keys across equivalent origin spellings", () => {
    const store = adapterFor("https://assets.example.com/assets");
    const segment = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"), { minLength: 1, maxLength: 24 })
      .map((characters) => characters.join(""));

    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
      const key = `${segments.join("/")}.png`;

      expect(store.keyFromUrl(store.publicUrl(key))).toBe(key);
      expect(store.keyFromUrl(`https://ASSETS.EXAMPLE.COM:443/assets/${key}?download=1#preview`)).toBe(key);
    }));
  });

});
