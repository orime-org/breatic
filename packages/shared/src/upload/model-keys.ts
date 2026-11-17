// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the ingest Worker reads the model keys of a web-animation call from our server (inner#1953). Before each model
 * call the Worker asks the server that submitted the job (`MODEL_KEYS_PATH`), signing the request with the shared
 * secret over a timestamp and the body; the server answers the keys as a compact JWE (RFC 7516, `RSA-OAEP-256` +
 * `A256GCM`) sealed with the Worker's public key, so only the Worker's private key opens it. Both ends call these
 * functions on two runtimes, so the format is written here once.
 *
 * Nothing here puts a key into an error: a failure to open is {@link ModelKeysUnreadable}, with no cause attached.
 */

import { CompactEncrypt, compactDecrypt, importPKCS8, importSPKI } from "jose";
import { z } from "zod";

import { decodeBase64Bytes, encodeBase64Bytes } from "@shared/upload/base64.js";

/** Where the Worker asks for the keys, under the server's base address. */
export const MODEL_KEYS_PATH = "/api/v1/ingest/model-keys";

/** The request's Unix-seconds timestamp. */
export const MODEL_KEYS_TIMESTAMP_HEADER = "x-ingest-timestamp";

/** The request's HMAC-SHA-256 over `<timestamp>.<body>`, base64. */
export const MODEL_KEYS_SIGNATURE_HEADER = "x-ingest-signature";

/** The content type of a sealed answer. */
export const MODEL_KEYS_SEALED_TYPE = "application/jose";

/** What the Worker asks: the keys of these upstreams of this execution's plan. */
export const modelKeysRequestSchema = z.object({
  executionId: z.uuid(),
  upstreams: z.array(z.string().min(1).max(64)).min(1).max(16),
});

/** What the Worker asks. */
export type ModelKeysRequest = z.infer<typeof modelKeysRequestSchema>;

/**
 * A definite refusal the Worker ends the execution on: the account's key row is gone (`account_key_missing`, naming
 * its upstream when known), or the deployment holds a key for none of the asked upstreams (`not_configured`).
 */
export const modelKeysRefusalSchema = z.object({
  code: z.enum(["account_key_missing", "not_configured"]),
  upstream: z.string().min(1).optional(),
});

/** A definite refusal. */
export type ModelKeysRefusal = z.infer<typeof modelKeysRefusalSchema>;

/** The status a definite refusal is answered with. */
export const MODEL_KEYS_REFUSAL_STATUS = 409;

const ALG = "RSA-OAEP-256";
const ENC = "A256GCM";
const HMAC = { name: "HMAC", hash: "SHA-256" } as const;
const TIMESTAMP = /^[0-9]{1,15}$/;

/** A sealed answer that could not be opened or read; it carries no cause, so no key reaches a log through it. */
export class ModelKeysUnreadable extends Error {
  /**
   * Name the failure.
   */
  constructor() {
    super("The sealed model keys could not be opened");
    this.name = "ModelKeysUnreadable";
  }
}

/**
 * A PEM as an environment variable may hold it: on one line, its line breaks written as `\n`.
 * @param pem - The value.
 * @returns The PEM with real line breaks.
 * @throws {never} Never.
 */
function pemOf(pem: string): string {
  return pem.replace(/\\n/g, "\n").trim();
}

/**
 * Seal a map of upstream to key for the Worker.
 * @param keys - The keys, by upstream.
 * @param publicKeyPem - The Worker's public key, SPKI PEM.
 * @returns The compact JWE.
 * @throws {Error} When the public key cannot be read.
 */
export async function sealModelKeys(keys: Readonly<Record<string, string>>, publicKeyPem: string): Promise<string> {
  const key = await importSPKI(pemOf(publicKeyPem), ALG);
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(keys)))
    .setProtectedHeader({ alg: ALG, enc: ENC })
    .encrypt(key);
}

/**
 * Open what {@link sealModelKeys} sealed.
 * @param sealed - The compact JWE.
 * @param privateKeyPem - The Worker's private key, PKCS#8 PEM.
 * @returns The keys, by upstream.
 * @throws {ModelKeysUnreadable} When the key cannot be read, the seal does not open, or it holds no map of strings.
 */
export async function openModelKeys(sealed: string, privateKeyPem: string): Promise<Record<string, string>> {
  let payload: unknown;
  try {
    const key = await importPKCS8(pemOf(privateKeyPem), ALG);
    const { plaintext } = await compactDecrypt(sealed, key, { keyManagementAlgorithms: [ALG], contentEncryptionAlgorithms: [ENC] });
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    // Dropped on purpose: no cause of a failed open is passed on, so nothing about the keys can reach a log.
    throw new ModelKeysUnreadable();
  }
  const read = z.record(z.string(), z.string()).safeParse(payload);
  if (!read.success) throw new ModelKeysUnreadable();
  return read.data;
}

/**
 * Import the shared secret as an HMAC key.
 * @param secret - The shared secret.
 * @returns The key.
 * @throws {Error} When the platform refuses the key.
 */
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), HMAC, false, ["sign", "verify"]);
}

/**
 * Sign a key request.
 * @param secret - The shared secret.
 * @param timestampSeconds - Unix seconds, sent as {@link MODEL_KEYS_TIMESTAMP_HEADER}.
 * @param body - The raw body as sent.
 * @returns The signature, sent as {@link MODEL_KEYS_SIGNATURE_HEADER}.
 * @throws {Error} When the platform refuses the key.
 */
export async function signModelKeysRequest(secret: string, timestampSeconds: number, body: string): Promise<string> {
  const signature = await crypto.subtle.sign(HMAC, await hmacKey(secret), new TextEncoder().encode(`${timestampSeconds}.${body}`));
  return encodeBase64Bytes(signature);
}

/** What one key request carried and when it arrived. */
export interface ModelKeysRequestCheck {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  nowSeconds: number;
  windowSeconds: number;
}

/**
 * Check a key request's headers, timestamp window and signature, in that order. An empty secret verifies nothing.
 * @param check - The request and the clock.
 * @returns `ok`, or the step that refused it.
 * @throws {never} Never.
 */
export async function verifyModelKeysRequest(check: ModelKeysRequestCheck): Promise<"ok" | "headers" | "timestamp" | "signature"> {
  const { timestamp, signature } = check;
  if (timestamp === undefined || signature === undefined || !TIMESTAMP.test(timestamp)) return "headers";
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64Bytes(signature);
  } catch {
    // Not base64 is a malformed header, the same answer as a missing one.
    return "headers";
  }
  if (Math.abs(Number(timestamp) - check.nowSeconds) > check.windowSeconds) return "timestamp";
  if (check.secret.trim() === "") return "signature";
  const valid = await crypto.subtle.verify(HMAC, await hmacKey(check.secret), signatureBytes, new TextEncoder().encode(`${timestamp}.${check.body}`));
  return valid ? "ok" : "signature";
}
