// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the identity token: the global region signs who the user is for
 * sixty seconds, and every other region checks it with a public key alone.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_TOKEN_TTL_SECONDS,
  signIdentityToken,
  verifyIdentityToken,
  type IdentityClaimsInput,
} from "@core/auth/identity-token.js";

/**
 * A fresh Ed25519 key pair in PEM.
 * @returns The private and public key.
 */
function keyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const CURRENT = keyPair();
const PREVIOUS = keyPair();
const NOW = 1_800_000_000;

const CLAIMS: IdentityClaimsInput = {
  sub: "11111111-1111-4111-8111-111111111111",
  sid: "a".repeat(64),
  email: "user@example.test",
  tier: "base",
  locale: "en",
  personalStudio: {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "my-studio",
    name: "My Studio",
    avatarUrl: null,
  },
};

/**
 * Decode one base64url segment of a compact JWS as JSON.
 * @param segment - The segment.
 * @returns The parsed value.
 */
function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("identity token", () => {
  it("is a compact JWS signed with EdDSA under the key's kid", () => {
    const token = signIdentityToken(CLAIMS, { kid: "k2", privateKey: CURRENT.privateKey }, NOW);
    const segments = token.split(".");
    expect(segments).toHaveLength(3);
    expect(decodeSegment(segments[0]!)).toEqual({ alg: "EdDSA", typ: "JWT", kid: "k2" });
  });

  it("lives sixty seconds from the moment it was signed", () => {
    const token = signIdentityToken(CLAIMS, { kid: "k2", privateKey: CURRENT.privateKey }, NOW);
    const payload = decodeSegment(token.split(".")[1]!);
    expect(IDENTITY_TOKEN_TTL_SECONDS).toBe(60);
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 60);
  });

  it("gives back every claim it was signed with", () => {
    const token = signIdentityToken(CLAIMS, { kid: "k2", privateKey: CURRENT.privateKey }, NOW);
    const verdict = verifyIdentityToken(token, { k2: CURRENT.publicKey }, NOW + 10);
    expect(verdict).toEqual({ ok: true, claims: { ...CLAIMS, iat: NOW, exp: NOW + 60 } });
  });

  it("accepts a token right up to its expiry and refuses it from then on", () => {
    const token = signIdentityToken(CLAIMS, { kid: "k2", privateKey: CURRENT.privateKey }, NOW);
    expect(verifyIdentityToken(token, { k2: CURRENT.publicKey }, NOW + 59).ok).toBe(true);
    expect(verifyIdentityToken(token, { k2: CURRENT.publicKey }, NOW + 60)).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts tokens under either key while a key is being rotated", () => {
    const keys = { k1: PREVIOUS.publicKey, k2: CURRENT.publicKey };
    const old = signIdentityToken(CLAIMS, { kid: "k1", privateKey: PREVIOUS.privateKey }, NOW);
    const fresh = signIdentityToken(CLAIMS, { kid: "k2", privateKey: CURRENT.privateKey }, NOW);
    expect(verifyIdentityToken(old, keys, NOW).ok).toBe(true);
    expect(verifyIdentityToken(fresh, keys, NOW).ok).toBe(true);
  });

  it("refuses a kid this region has no key for", () => {
    const token = signIdentityToken(CLAIMS, { kid: "k3", privateKey: CURRENT.privateKey }, NOW);
    expect(verifyIdentityToken(token, { k2: CURRENT.publicKey }, NOW)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("refuses a token signed by a different key under a known kid", () => {
    const token = signIdentityToken(CLAIMS, { kid: "k2", privateKey: PREVIOUS.privateKey }, NOW);
    expect(verifyIdentityToken(token, { k2: CURRENT.publicKey }, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a token whose payload was changed after signing", () => {
    const [header, , signature] = signIdentityToken(
      CLAIMS,
      { kid: "k2", privateKey: CURRENT.privateKey },
      NOW,
    ).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, sub: "33333333-3333-4333-8333-333333333333", iat: NOW, exp: NOW + 60 }),
    ).toString("base64url");
    expect(verifyIdentityToken(`${header}.${forged}.${signature}`, { k2: CURRENT.publicKey }, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuses a header that names any algorithm other than EdDSA", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "k2" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, iat: NOW, exp: NOW + 60 })).toString("base64url");
    const signature = sign(null, Buffer.from(`${header}.${payload}`), CURRENT.privateKey).toString("base64url");
    expect(verifyIdentityToken(`${header}.${payload}.${signature}`, { k2: CURRENT.publicKey }, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses any string that is not a well-formed token without throwing", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const verdict = verifyIdentityToken(text, { k2: CURRENT.publicKey }, NOW);
        expect(verdict.ok).toBe(false);
      }),
    );
  });

  it("refuses a well-signed payload that lacks the user or session id", () => {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "k2" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ email: "user@example.test", iat: NOW, exp: NOW + 60 })).toString(
      "base64url",
    );
    const signature = sign(null, Buffer.from(`${header}.${payload}`), CURRENT.privateKey).toString("base64url");
    expect(verifyIdentityToken(`${header}.${payload}.${signature}`, { k2: CURRENT.publicKey }, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
