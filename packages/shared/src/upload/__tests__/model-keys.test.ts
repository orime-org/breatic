// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The payer's own model keys of a web-animation job (inner#1953): our worker seals them as a compact JWE
 * (`RSA-OAEP-256` + `A256GCM`) that only the ingest Worker's private key opens. Both ends call these functions, so one
 * copy of the format serves both.
 */

import fc from "fast-check";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { ModelKeysUnreadable, openModelKeys, sealModelKeys } from "@shared/upload/model-keys.js";

let publicKey: string;
let privateKey: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RSA-OAEP-256", { extractable: true });
  publicKey = await exportSPKI(pair.publicKey);
  privateKey = await exportPKCS8(pair.privateKey);
});

describe("sealModelKeys / openModelKeys", () => {
  it("opens what it sealed, for any map of upstream to key", async () => {
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 200 })), async (keys) => {
        const sealed = await sealModelKeys(keys, publicKey);
        expect(await openModelKeys(sealed, privateKey)).toEqual(keys);
      }),
      { numRuns: 25 },
    );
  });

  it("opens an upstream whose name is an Object.prototype member as an own entry", async () => {
    const keys: Record<string, string> = JSON.parse('{"__proto__":"k1","constructor":"k2"}');
    const opened = await openModelKeys(await sealModelKeys(keys, publicKey), privateKey);
    expect(Object.entries(opened)).toEqual([["__proto__", "k1"], ["constructor", "k2"]]);
  });

  it("refuses an upstream named __proto__ whose key is not a string, which the schema does not read", async () => {
    const sealed = await sealModelKeys(JSON.parse('{"__proto__":5}') as Record<string, string>, publicKey);

    await expect(openModelKeys(sealed, privateKey)).rejects.toBeInstanceOf(ModelKeysUnreadable);
  });

  it("writes a compact JWE with RSA-OAEP-256 and A256GCM that does not carry a key in the clear", async () => {
    const sealed = await sealModelKeys({ openrouter: "sk-or-v1-secret-value" }, publicKey);

    const parts = sealed.split(".");
    expect(parts).toHaveLength(5);
    expect(JSON.parse(atob(parts[0]!.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({ alg: "RSA-OAEP-256", enc: "A256GCM" });
    expect(sealed).not.toContain("sk-or-v1-secret-value");
  });

  it("refuses any altered seal with ModelKeysUnreadable that names no key", async () => {
    const key = "sk-or-v1-tamper-target";
    const sealed = await sealModelKeys({ openrouter: key }, publicKey);
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: sealed.length - 1 }), fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), async (at, swap) => {
        fc.pre(sealed[at] !== "." && sealed[at] !== swap);
        const altered = `${sealed.slice(0, at)}${swap}${sealed.slice(at + 1)}`;
        const error = await openModelKeys(altered, privateKey).then(() => null, (err: unknown) => err);
        // A swap in the last base64url character of a part can leave its bytes unchanged; only a real change must fail.
        if (error === null) return;
        expect(error).toBeInstanceOf(ModelKeysUnreadable);
        expect(String((error as Error).message)).not.toContain(key);
        expect((error as Error).cause).toBeUndefined();
      }),
      { numRuns: 60 },
    );
  });

  it("refuses a seal opened with another private key", async () => {
    const other = await generateKeyPair("RSA-OAEP-256", { extractable: true });
    const sealed = await sealModelKeys({ openrouter: "k" }, publicKey);

    await expect(openModelKeys(sealed, await exportPKCS8(other.privateKey))).rejects.toBeInstanceOf(ModelKeysUnreadable);
  });

  it("refuses a sealed payload that is not a map of strings", async () => {
    const sealed = await sealModelKeys({ openrouter: 1 } as unknown as Record<string, string>, publicKey);

    await expect(openModelKeys(sealed, privateKey)).rejects.toBeInstanceOf(ModelKeysUnreadable);
  });

  it("reads a PEM written on one line with literal \\n, as an environment variable holds it", async () => {
    const sealed = await sealModelKeys({ openrouter: "k" }, publicKey.replace(/\n/g, "\\n"));

    expect(await openModelKeys(sealed, privateKey.replace(/\n/g, "\\n"))).toEqual({ openrouter: "k" });
  });
});
