// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The credential format the upload pipeline uses twice: a JSON payload and an
 * HMAC over it, as `base64(json).base64(signature)`.
 *
 * Upload tickets and session tokens carry different payloads and are refused
 * for different reasons, but they are signed with the same secret, encoded the
 * same way and read back the same way. One implementation, so a change to the
 * algorithm or the encoding cannot leave the two disagreeing — the server
 * signs both and the Worker verifies both, and a disagreement between them
 * reads as every upload being unauthorised.
 */

import {
  encodeBase64Utf8,
  decodeBase64Utf8,
  encodeBase64Bytes,
  decodeBase64Bytes,
} from "@shared/upload/base64.js";

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Import a shared secret as an HMAC key.
 * @param secret - The value both sides hold.
 * @returns A key usable for signing and verifying.
 */
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    ALGORITHM,
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign a payload into a token.
 * @param payload - What the token carries.
 * @param secret - The shared secret.
 * @returns The token, as `base64(json).base64(signature)`.
 */
export async function signPayload(
  payload: unknown,
  secret: string,
): Promise<string> {
  const body = encodeBase64Utf8(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encodeBase64Bytes(signature)}`;
}

/** Why a token could not be read back. */
export type SignedPayloadRejection = "malformed" | "bad_signature";

/** What reading a token back produced. */
export type SignedPayloadReading<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: SignedPayloadRejection };

/**
 * Read a token back, or say why it cannot be used.
 *
 * Never throws: anything reaching this came off the public internet, so a
 * malformed token is an answer rather than an exception. Whether the payload
 * is still in date is the caller's to decide — the two credentials measure
 * that against different fields.
 * @param token - The token as presented.
 * @param secret - The shared secret.
 * @returns The payload, or why it was refused.
 */
export async function readSignedPayload<T>(
  token: string,
  secret: string,
): Promise<SignedPayloadReading<T>> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [body, signature] = parts as [string, string];

  let signatureBytes: Uint8Array;
  let payload: T;
  try {
    signatureBytes = decodeBase64Bytes(signature);
    payload = JSON.parse(decodeBase64Utf8(body)) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const valid = await crypto.subtle.verify(
    ALGORITHM,
    await hmacKey(secret),
    signatureBytes,
    new TextEncoder().encode(body),
  );
  if (!valid) return { ok: false, reason: "bad_signature" };
  return { ok: true, payload };
}
