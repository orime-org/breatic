// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  InvalidProviderKey,
  ProviderKeySealBroken,
  displayHintOf,
  normalizeProviderKey,
  openProviderKey,
  sealProviderKey,
  type ProviderKeyRing,
} from "../provider-key-box.js";

const ringOf = (current: string, ...ids: string[]): ProviderKeyRing => ({
  current,
  keys: Object.fromEntries([current, ...ids].map((id) => [id, randomBytes(32)])),
});

const printable = fc.stringMatching(/^[\x21-\x7E]{1,200}$/);

describe("sealProviderKey and openProviderKey", () => {
  it("opens what it sealed, for any printable key", () => {
    const ring = ringOf("k1");
    fc.assert(fc.property(printable, (key) => {
      expect(openProviderKey(sealProviderKey(key, ring), ring)).toBe(key);
    }));
  });

  it("never writes the key itself into the sealed text", () => {
    const ring = ringOf("k1");
    fc.assert(fc.property(fc.stringMatching(/^[\x21-\x7E]{8,200}$/), (key) => {
      expect(sealProviderKey(key, ring)).not.toContain(key);
    }));
  });

  it("seals the same key differently each time", () => {
    const ring = ringOf("k1");
    expect(sealProviderKey("sk-or-v1-abc", ring)).not.toBe(sealProviderKey("sk-or-v1-abc", ring));
  });

  it("names the key it was sealed with, so a later current key still opens it", () => {
    const old = ringOf("k1");
    const sealed = sealProviderKey("sk-or-v1-abc", old);
    expect(sealed.startsWith("v1:k1:")).toBe(true);
    const rotated: ProviderKeyRing = { current: "k2", keys: { ...old.keys, k2: randomBytes(32) } };
    expect(openProviderKey(sealed, rotated)).toBe("sk-or-v1-abc");
    expect(sealProviderKey("sk-or-v1-abc", rotated).startsWith("v1:k2:")).toBe(true);
  });

  it("refuses a sealed text whose key id the ring no longer holds", () => {
    const sealed = sealProviderKey("sk-or-v1-abc", ringOf("k1"));
    expect(() => openProviderKey(sealed, ringOf("k2"))).toThrow(ProviderKeySealBroken);
  });

  it("refuses any change to the sealed text", () => {
    const ring = ringOf("k1");
    const sealed = sealProviderKey("sk-or-v1-abcdef", ring);
    fc.assert(fc.property(fc.nat({ max: sealed.length - 1 }), (at) => {
      const flipped = sealed.slice(0, at) + (sealed[at] === "0" ? "1" : "0") + sealed.slice(at + 1);
      fc.pre(flipped !== sealed);
      expect(() => openProviderKey(flipped, ring)).toThrow(ProviderKeySealBroken);
    }));
  });

  it("puts neither the key nor the sealed text in its errors", () => {
    const ring = ringOf("k1");
    const sealed = sealProviderKey("sk-or-v1-secretvalue", ring);
    const broken = `${sealed.slice(0, -2)}00`;
    try {
      openProviderKey(broken, ring);
      expect.unreachable();
    } catch (err) {
      const text = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack ?? ""}`;
      expect(text).not.toContain("secretvalue");
      expect(text).not.toContain(broken);
    }
  });

  it("refuses to seal with a ring whose current key is missing or not 32 bytes", () => {
    expect(() => sealProviderKey("sk", { current: "k1", keys: {} })).toThrow(ProviderKeySealBroken);
    expect(() => sealProviderKey("sk", { current: "k1", keys: { k1: randomBytes(16) } })).toThrow(ProviderKeySealBroken);
  });
});

describe("normalizeProviderKey", () => {
  it("trims the surrounding whitespace a paste brings", () => {
    expect(normalizeProviderKey("  sk-or-v1-abc\n")).toBe("sk-or-v1-abc");
  });

  it("refuses a key with a control character inside, without repeating it", () => {
    for (const raw of ["sk-or\nv1", "sk-or\rv1", "sk\u0000or", "sk or", "sk-ör"]) {
      try {
        normalizeProviderKey(raw);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidProviderKey);
        expect(String(err)).not.toContain(raw.trim());
      }
    }
  });

  it("refuses an empty key and one past the length bound", () => {
    expect(() => normalizeProviderKey("   ")).toThrow(InvalidProviderKey);
    expect(() => normalizeProviderKey("a".repeat(1025))).toThrow(InvalidProviderKey);
    expect(normalizeProviderKey("a".repeat(1024))).toHaveLength(1024);
  });
});

describe("displayHintOf", () => {
  it("shows the first six and last four characters", () => {
    expect(displayHintOf("sk-or-v1-0123456789a1B2")).toBe("sk-or-…a1B2");
  });

  it("shows only the last four of a key too short to show both ends apart", () => {
    expect(displayHintOf("abcdefgh")).toBe("…efgh");
  });

  it("never shows the whole key", () => {
    fc.assert(fc.property(printable, (key) => {
      expect(displayHintOf(key)).not.toBe(key);
      expect(displayHintOf(key).replace("…", "").length).toBeLessThan(key.length);
    }));
  });
});
