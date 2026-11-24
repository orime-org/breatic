// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The master keys that seal accounts' provider keys (inner#1953): `PROVIDER_KEY_SECRET_ID` names the key new seals
 * use, `PROVIDER_KEY_SECRETS` is a JSON object of every key by id, each 32 bytes as 64 hex characters. A deployment
 * that sets neither runs with bring-your-own-key off; one that sets them half or wrongly refuses to start, without
 * repeating a secret in the message. `BYOK_ENABLED` is the deployment's switch (#1618): only `true` turns the feature
 * on, and turning it on needs the master keys.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@core/config/schema.js";
import { openProviderKey, providerKeyRingOf, sealProviderKey } from "@core/secrets/provider-key-box.js";

/**
 * Minimal valid raw env for {@link parseConfig}, overridable per case.
 * @param over - Fields to override.
 * @returns The raw env.
 */
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
    YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic_yjs",
    ...over,
  };
}

const hex = (): string => randomBytes(32).toString("hex");

describe("PROVIDER_KEY_SECRET_ID and PROVIDER_KEY_SECRETS", () => {
  it("reads the current id and every secret by id", () => {
    const k1 = hex();
    const k2 = hex();
    const cfg = parseConfig(baseEnv({ PROVIDER_KEY_SECRET_ID: "k2", PROVIDER_KEY_SECRETS: JSON.stringify({ k1, k2 }) }));
    expect(cfg.PROVIDER_KEY_SECRET_ID).toBe("k2");
    expect(cfg.PROVIDER_KEY_SECRETS).toEqual({ k1, k2 });
  });

  it("builds the key ring from them: the current id seals, every id opens", () => {
    const k1 = hex();
    const k2 = hex();
    const ring = providerKeyRingOf(
      parseConfig(baseEnv({ BYOK_ENABLED: "true", PROVIDER_KEY_SECRET_ID: "k2", PROVIDER_KEY_SECRETS: JSON.stringify({ k1, k2 }) })),
    );
    if (ring === null) return expect.unreachable("no ring built from a complete configuration");
    expect(ring.current).toBe("k2");
    expect(ring.keys["k1"]?.equals(Buffer.from(k1, "hex"))).toBe(true);
    expect(ring.keys["k2"]?.equals(Buffer.from(k2, "hex"))).toBe(true);
    const sealed = sealProviderKey("sk-or-v1-abc", ring);
    expect(sealed.startsWith("v1:k2:")).toBe(true);
    expect(openProviderKey(sealed, ring)).toBe("sk-or-v1-abc");
  });

  it("reports bring-your-own-key off when neither is set", () => {
    const cfg = parseConfig(baseEnv());
    expect(providerKeyRingOf(cfg)).toBeNull();
  });

  it("refuses to start with one set and not the other", () => {
    expect(() => parseConfig(baseEnv({ PROVIDER_KEY_SECRET_ID: "k1" }))).toThrow(/^FATAL: .*PROVIDER_KEY_SECRETS.*Refusing to start\.$/s);
    expect(() => parseConfig(baseEnv({ PROVIDER_KEY_SECRETS: JSON.stringify({ k1: hex() }) }))).toThrow(
      /^FATAL: .*PROVIDER_KEY_SECRET_ID.*Refusing to start\.$/s,
    );
  });

  it("refuses to start when the current id names no secret", () => {
    expect(() => parseConfig(baseEnv({ PROVIDER_KEY_SECRET_ID: "k9", PROVIDER_KEY_SECRETS: JSON.stringify({ k1: hex() }) }))).toThrow(
      /^FATAL: .*PROVIDER_KEY_SECRET_ID.*Refusing to start\.$/s,
    );
  });

  it("refuses a secret that is not 32 bytes of hex, without repeating it", () => {
    for (const bad of ["abc123", hex().slice(2), `${hex().slice(1)}z`, randomBytes(16).toString("hex")]) {
      try {
        parseConfig(baseEnv({ PROVIDER_KEY_SECRET_ID: "k1", PROVIDER_KEY_SECRETS: JSON.stringify({ k1: bad }) }));
        expect.unreachable();
      } catch (err) {
        expect(String(err)).toMatch(/^Error: FATAL: .*PROVIDER_KEY_SECRETS.*Refusing to start\.$/s);
        expect(String(err)).not.toContain(bad);
      }
    }
  });
});

describe("BYOK_ENABLED (#1618)", () => {
  const ringEnv = (): Record<string, string> => ({ PROVIDER_KEY_SECRET_ID: "k1", PROVIDER_KEY_SECRETS: JSON.stringify({ k1: hex() }) });

  it("is off unless it is exactly true", () => {
    expect(parseConfig(baseEnv()).BYOK_ENABLED).toBe(false);
    for (const value of ["false", "", "TRUE", "1", "yes"]) {
      expect(parseConfig(baseEnv({ BYOK_ENABLED: value, ...ringEnv() })).BYOK_ENABLED, value).toBe(false);
    }
    expect(parseConfig(baseEnv({ BYOK_ENABLED: "true", ...ringEnv() })).BYOK_ENABLED).toBe(true);
  });

  it("builds no key ring while it is off, even with the master keys set", () => {
    expect(providerKeyRingOf(parseConfig(baseEnv(ringEnv())))).toBeNull();
    expect(providerKeyRingOf(parseConfig(baseEnv({ BYOK_ENABLED: "false", ...ringEnv() })))).toBeNull();
    expect(providerKeyRingOf(parseConfig(baseEnv({ BYOK_ENABLED: "true", ...ringEnv() })))?.current).toBe("k1");
  });

  it("refuses to start when it is on without the master keys", () => {
    expect(() => parseConfig(baseEnv({ BYOK_ENABLED: "true" }))).toThrow(
      /^FATAL: BYOK_ENABLED=true requires PROVIDER_KEY_SECRET_ID and PROVIDER_KEY_SECRETS.*Refusing to start\.$/s,
    );
  });
});
