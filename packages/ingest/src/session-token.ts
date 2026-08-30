// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The credential a part carries (#173, design §4.2).
 *
 * A ticket opens an upload; this is what writes into one. Splitting them is
 * what bounds a leak: a stolen ticket could start uploads under someone's
 * quota, while a stolen session token can only add bytes to the one upload it
 * names, which is already going to be replaced on the next part anyway.
 *
 * It is re-issued with every part, so its lifetime only has to cover the gap
 * between two parts rather than a whole upload — which is why a slow 2 GiB
 * upload never needs a long-lived credential.
 */

/** What a session token says. */
export interface SessionTokenPayload {
  /** The upload it may write into. */
  storageKey: string;
  /** R2's own id for the multipart upload. */
  uploadId: string;
  /** Epoch ms after which it is refused. */
  expiresAt: number;
}

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Import the shared secret as an HMAC key.
 * @param secret - The value our server and this Worker both hold.
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
 * Base64 a string without depending on Node's Buffer.
 * @param value - The text to encode.
 * @returns Its base64 form.
 */
function encodeBase64(value: string): string {
  return btoa(value);
}

/**
 * Decode base64 back to a string.
 * @param value - The base64 text.
 * @returns The decoded string.
 */
function decodeBase64(value: string): string {
  return atob(value);
}

/**
 * Issue a token for the next part of an upload.
 * @param payload - What the token grants.
 * @param secret - The shared secret.
 * @returns The token, as `base64(json).base64(signature)`.
 */
export async function signSessionToken(
  payload: SessionTokenPayload,
  secret: string,
): Promise<string> {
  const body = encodeBase64(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encodeBase64(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/**
 * Read a session token back, or say why it cannot be used.
 *
 * Never throws: anything reaching this came off the public internet.
 * @param token - The token the browser sent.
 * @param secret - The shared secret.
 * @param now - Current time in epoch ms.
 * @returns The payload, or null when the token is unusable.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  now: number,
): Promise<SessionTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts as [string, string];

  let signatureBytes: Uint8Array;
  let payload: SessionTokenPayload;
  try {
    const raw = decodeBase64(signature);
    signatureBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) signatureBytes[i] = raw.charCodeAt(i);
    payload = JSON.parse(decodeBase64(body)) as SessionTokenPayload;
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    ALGORITHM,
    await hmacKey(secret),
    signatureBytes,
    new TextEncoder().encode(body),
  );
  if (!valid) return null;
  if (now > payload.expiresAt) return null;
  return payload;
}
