// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The model-key channel between the ingest Worker and our server (inner#1953): the Worker signs its request with the
 * shared secret and a timestamp, and the server answers the keys sealed as a compact JWE (`RSA-OAEP-256` + `A256GCM`)
 * that only the Worker's private key opens. Both ends call these functions, so one copy of the format serves both.
 */

import fc from "fast-check";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ModelKeysUnreadable,
  openModelKeys,
  sealModelKeys,
  signModelKeysRequest,
  verifyModelKeysRequest,
} from "@shared/upload/model-keys.js";

const SECRET = "test-ingest-secret";
const BODY = JSON.stringify({ executionId: "7f1b6f1e-3c1e-4a8e-9a5e-2f1f6b0a9c11", upstreams: ["openrouter"] });

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

describe("signModelKeysRequest / verifyModelKeysRequest", () => {
  const NOW = 1_800_000_000;

  it("accepts a request signed with the secret within the window", async () => {
    const signature = await signModelKeysRequest(SECRET, NOW, BODY);

    expect(await verifyModelKeysRequest({ secret: SECRET, timestamp: String(NOW), signature, body: BODY, nowSeconds: NOW + 299, windowSeconds: 300 })).toBe("ok");
  });

  it("refuses a timestamp outside the window", async () => {
    const signature = await signModelKeysRequest(SECRET, NOW, BODY);

    expect(await verifyModelKeysRequest({ secret: SECRET, timestamp: String(NOW), signature, body: BODY, nowSeconds: NOW + 301, windowSeconds: 300 })).toBe("timestamp");
    expect(await verifyModelKeysRequest({ secret: SECRET, timestamp: String(NOW), signature, body: BODY, nowSeconds: NOW - 301, windowSeconds: 300 })).toBe("timestamp");
  });

  it("refuses a changed body, timestamp or secret, and missing or malformed headers", async () => {
    const signature = await signModelKeysRequest(SECRET, NOW, BODY);
    const base = { secret: SECRET, timestamp: String(NOW), signature, body: BODY, nowSeconds: NOW, windowSeconds: 300 };

    expect(await verifyModelKeysRequest({ ...base, body: BODY.replace("openrouter", "fal") })).toBe("signature");
    expect(await verifyModelKeysRequest({ ...base, timestamp: String(NOW + 1) })).toBe("signature");
    expect(await verifyModelKeysRequest({ ...base, secret: "another-secret" })).toBe("signature");
    expect(await verifyModelKeysRequest({ ...base, secret: "" })).toBe("signature");
    expect(await verifyModelKeysRequest({ ...base, signature: undefined })).toBe("headers");
    expect(await verifyModelKeysRequest({ ...base, timestamp: "soon" })).toBe("headers");
    expect(await verifyModelKeysRequest({ ...base, signature: "%%%" })).toBe("headers");
  });

  it("accepts only the exact signed body, for any body", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (body, other) => {
        fc.pre(body !== other);
        const signature = await signModelKeysRequest(SECRET, NOW, body);
        const base = { secret: SECRET, timestamp: String(NOW), signature, nowSeconds: NOW, windowSeconds: 300 };
        expect(await verifyModelKeysRequest({ ...base, body })).toBe("ok");
        expect(await verifyModelKeysRequest({ ...base, body: other })).toBe("signature");
      }),
      { numRuns: 50 },
    );
  });
});
