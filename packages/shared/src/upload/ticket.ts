// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload ticket: what our server hands the browser so the ingest Worker will
 * accept its bytes (#173 design §4.1).
 *
 * Signed by our server, verified by the ingest Worker. Those two runtimes
 * share no Node API, so both the signing and the verification here go through
 * Web Crypto, which Cloudflare Workers and Node both expose as a global. That
 * is also why this module lives in the one workspace package with no `node:`
 * imports rather than in `@breatic/core`, which the Worker cannot load.
 */

/**
 * R2 requires every part except the last to be at least this large. A smaller
 * `partSize` in the config makes R2 reject every part from the second one on,
 * so the ticket endpoint refuses to mint a multi-part ticket under it.
 *
 * Source: Cloudflare R2 multipart upload limits.
 */
export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/** Everything the ingest Worker needs to accept an upload, all of it signed. */
export interface UploadTicketPayload {
  /** Object key our server minted. Tenant-neutral. */
  storageKey: string;
  /** Studio the bytes will be billed to. */
  studioId: string;
  /** User who asked for the ticket. */
  userId: string;
  /** How many parts the browser will send. The sole basis for "all in?". */
  totalParts: number;
  /** Size of every part except the last. */
  partSize: number;
  /** Upper bound on a single part's length, so the Worker can check statelessly. */
  maxBytes: number;
  /** Written into the R2 object's httpMetadata. */
  contentType: string;
  /** Epoch ms. Checked once, when the upload starts. */
  expiresAt: number;
  /** The node's fencing gen, echoed back so the server can CAS its event. */
  leaseGen: number;
}

/** Why a ticket did not verify. */
export type UploadTicketRejection = "malformed" | "bad_signature" | "expired";

/** Outcome of verifying a ticket. */
export type UploadTicketVerification =
  | { ok: true; payload: UploadTicketPayload }
  | { ok: false; reason: UploadTicketRejection };

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Import a shared secret as an HMAC key.
 * @param secret - The shared secret both sides hold.
 * @returns A CryptoKey usable for signing and verifying.
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
 * Base64 a UTF-8 string. Goes through bytes rather than handing the string
 * straight to `btoa`, which throws on anything outside latin1.
 * @param value - The string to encode.
 * @returns Its base64 form.
 */
function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reverse {@link encodeBase64}.
 * @param value - A base64 string.
 * @returns The decoded UTF-8 string.
 * @throws {Error} When the input is not valid base64.
 */
function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Sign an upload ticket.
 *
 * The refusal here is a configuration error rather than user input: the part
 * size is derived by our own server from `config/storage.yaml`, so a ticket
 * that violates R2's floor means the config is wrong and R2 would reject every
 * part from the second one on.
 * @param payload - The ticket contents.
 * @param secret - The shared secret the ingest Worker also holds.
 * @returns The signed ticket, as `base64(json).base64(signature)`.
 * @throws {Error} When `partSize` is under R2's floor on a multi-part upload.
 */
export async function signUploadTicket(
  payload: UploadTicketPayload,
  secret: string,
): Promise<string> {
  if (payload.totalParts > 1 && payload.partSize < MIN_PART_SIZE_BYTES) {
    throw new Error(
      `partSize ${payload.partSize} is under R2's ${MIN_PART_SIZE_BYTES}-byte floor for a multi-part upload`,
    );
  }
  const body = encodeBase64(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encodeBase64(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/**
 * Verify a ticket and read back its payload.
 *
 * Never throws on bad input — a malformed token is something an attacker can
 * send at will, so it comes back as a rejection like any other.
 * @param token - The ticket as handed to the browser.
 * @param secret - The shared secret.
 * @param now - Current time in epoch ms, supplied by the caller.
 * @returns The payload when the ticket verifies, otherwise why it did not.
 */
export async function verifyUploadTicket(
  token: string,
  secret: string,
  now: number,
): Promise<UploadTicketVerification> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [body, signature] = parts as [string, string];

  let signatureBytes: Uint8Array;
  let payload: UploadTicketPayload;
  try {
    const raw = decodeBase64(signature);
    signatureBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) signatureBytes[i] = raw.charCodeAt(i);
    payload = JSON.parse(decodeBase64(body)) as UploadTicketPayload;
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

  if (now > payload.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
