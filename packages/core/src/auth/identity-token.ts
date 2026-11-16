// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The identity token (inner#1955): who the user is, signed by the global
 * region for sixty seconds, so a region that does not hold the sessions can
 * tell who is asking without asking anyone.
 *
 * It is a compact JWS (RFC 7515) with the header `{ alg: "EdDSA", typ: "JWT",
 * kid }` and an Ed25519 signature (RFC 8037). Only that header is accepted:
 * the algorithm is fixed here, never read from the token. Verification is
 * synchronous so it runs inside request auth with no extra await.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { MEMBERSHIP_TIERS } from "@breatic/shared";
import { z } from "zod";
import { env } from "@core/config/env.js";

/** How long a token is good for after it is signed. */
export const IDENTITY_TOKEN_TTL_SECONDS = 60;

/**
 * The cookie the token travels in, set on the parent domain so every region's
 * API host receives it. Named by `ENV`, which every region of one deployment
 * shares and a staging deployment under the production parent domain does
 * not. The session cookie is named by `REDIS_KEY_PREFIX`, which differs
 * between a deployment's regions, so it cannot name this one.
 * @returns The cookie name, e.g. `breatic_identity_prod`.
 */
export function identityCookieName(): string {
  return `breatic_identity_${env.ENV}`;
}

const personalStudioSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .nullable();

const claimsInputSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  email: z.string(),
  tier: z.enum(MEMBERSHIP_TIERS),
  locale: z.string(),
  personalStudio: personalStudioSchema,
});

const claimsSchema = claimsInputSchema.extend({
  iat: z.number().int(),
  exp: z.number().int(),
});

const headerSchema = z.object({ alg: z.literal("EdDSA"), typ: z.literal("JWT"), kid: z.string().min(1) }).strict();

/** What the global region says about the user. */
export type IdentityClaimsInput = z.infer<typeof claimsInputSchema>;

/** The claims of a verified token, with its signing and expiry times. */
export type IdentityClaims = z.infer<typeof claimsSchema>;

/** The key a token is signed with. */
export interface IdentitySigningKey {
  kid: string;
  /** Ed25519 private key, PEM. */
  privateKey: string;
}

/** Why a token was refused. */
export type IdentityRefusal = "malformed" | "unknown_key" | "signature" | "expired";

/** The outcome of checking a token. */
export type IdentityVerdict = { ok: true; claims: IdentityClaims } | { ok: false; reason: IdentityRefusal };

const keyCache = new Map<string, KeyObject>();

/**
 * A parsed key, built once per PEM.
 * @param pem - The PEM text.
 * @param kind - Which half it is.
 * @returns The key object.
 * @throws {Error} When the PEM is not a key of that kind.
 */
function keyOf(pem: string, kind: "private" | "public"): KeyObject {
  const cacheKey = `${kind}:${pem}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  keyCache.set(cacheKey, key);
  return key;
}

/**
 * One base64url JSON segment.
 * @param value - The value to encode.
 * @returns The segment.
 */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Parse one base64url JSON segment.
 * @param text - The segment.
 * @returns The parsed value, or undefined when it is not JSON.
 */
function parseSegment(text: string): unknown {
  try {
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Sign a token for the user.
 * @param claims - Who the user is.
 * @param key - The signing key and its kid.
 * @param nowSeconds - The signing time, in Unix seconds.
 * @returns The compact token.
 * @throws {Error} When the private key is not an Ed25519 PEM.
 */
export function signIdentityToken(claims: IdentityClaimsInput, key: IdentitySigningKey, nowSeconds: number): string {
  const header = segment({ alg: "EdDSA", typ: "JWT", kid: key.kid });
  const payload = segment({ ...claims, iat: nowSeconds, exp: nowSeconds + IDENTITY_TOKEN_TTL_SECONDS });
  const signature = sign(null, Buffer.from(`${header}.${payload}`), keyOf(key.privateKey, "private"));
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/**
 * Check a token with the public keys this region trusts.
 * @param token - The compact token.
 * @param publicKeys - Ed25519 public keys (PEM) by kid.
 * @param nowSeconds - The current time, in Unix seconds.
 * @returns The claims, or why the token was refused.
 */
export function verifyIdentityToken(
  token: string,
  publicKeys: Readonly<Record<string, string>>,
  nowSeconds: number,
): IdentityVerdict {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerText, payloadText, signatureText] = parts as [string, string, string];
  const header = headerSchema.safeParse(parseSegment(headerText));
  if (!header.success) return { ok: false, reason: "malformed" };
  const pem = Object.hasOwn(publicKeys, header.data.kid) ? publicKeys[header.data.kid] : undefined;
  if (pem === undefined) return { ok: false, reason: "unknown_key" };
  let valid: boolean;
  try {
    valid = verify(null, Buffer.from(`${headerText}.${payloadText}`), keyOf(pem, "public"), Buffer.from(signatureText, "base64url"));
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!valid) return { ok: false, reason: "signature" };
  const claims = claimsSchema.safeParse(parseSegment(payloadText));
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (nowSeconds >= claims.data.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims.data };
}
