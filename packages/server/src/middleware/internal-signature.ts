// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Request signing for the internal API (inner#1410 §4.2): the pure half of
 * the check — header formats, the ±300 s window and the HMAC. The nonce step
 * needs Redis and runs in `internal-auth.ts` after these.
 *
 * The signed text is seven lines joined by `\n`: method, path with its query
 * string as sent, timestamp, nonce, admin id, the `Idempotency-Key` header
 * (an empty line when absent) and the raw body. The idempotency key is signed
 * because it decides which disposition a request replays; changing it is
 * starting a different one.
 */

import { createHmac } from "node:crypto";
import { secretsMatch } from "@server/utils/secrets-match.js";

/** Everything the signature covers. */
export interface SignedParts {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  adminId: string;
  idempotencyKey: string | null;
  body: string;
}

/** The request as the middleware hands it over; header names lower case. */
export interface InternalRequest {
  method: string;
  pathWithQuery: string;
  headers: Record<string, string | undefined>;
  body: string;
}

/** Which check refused the request. */
export type VerifyResult =
  | { ok: true; adminId: string; nonce: string }
  | { ok: false; step: "headers" | "timestamp" | "signature" };

/** How far a request's timestamp may be from the server's clock. */
export const WINDOW_SECONDS = 300;

const ADMIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP = /^[0-9]+$/;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;

/**
 * The text the signature covers.
 * @param parts - The seven signed values.
 * @returns The seven lines joined by `\n`.
 */
export function canonicalString(parts: SignedParts): string {
  return [
    parts.method,
    parts.pathWithQuery,
    parts.timestamp,
    parts.nonce,
    parts.adminId,
    parts.idempotencyKey ?? "",
    parts.body,
  ].join("\n");
}

/**
 * Sign a request the way the back office does.
 * @param secret - The shared secret.
 * @param parts - The seven signed values.
 * @returns `v1=` plus the lowercase hex HMAC-SHA256.
 */
export function signRequest(secret: string, parts: SignedParts): string {
  return `v1=${createHmac("sha256", secret).update(canonicalString(parts), "utf8").digest("hex")}`;
}

/**
 * Check a request's signature headers, timestamp and HMAC, in that order.
 * Both the current and the previous secret are accepted; an empty or
 * whitespace-only one is no key at all.
 * @param req - The request.
 * @param secrets - The current and previous secrets.
 * @param secrets.current - The secret in use.
 * @param secrets.previous - The secret being rotated out, or empty.
 * @param nowSeconds - The server's clock, in Unix seconds.
 * @returns Who signed and with which nonce, or the step that failed.
 */
export function verifyInternalRequest(
  req: InternalRequest,
  secrets: { current: string; previous: string },
  nowSeconds: number,
): VerifyResult {
  const adminId = req.headers["x-internal-admin"];
  const timestamp = req.headers["x-internal-timestamp"];
  const nonce = req.headers["x-internal-nonce"];
  const signature = req.headers["x-internal-signature"];
  if (
    adminId === undefined ||
    timestamp === undefined ||
    nonce === undefined ||
    signature === undefined ||
    !ADMIN_ID.test(adminId) ||
    !TIMESTAMP.test(timestamp) ||
    !NONCE.test(nonce) ||
    !SIGNATURE.test(signature)
  ) {
    return { ok: false, step: "headers" };
  }
  if (Math.abs(Number(timestamp) - nowSeconds) > WINDOW_SECONDS) {
    return { ok: false, step: "timestamp" };
  }
  const parts: SignedParts = {
    method: req.method,
    pathWithQuery: req.pathWithQuery,
    timestamp,
    nonce,
    adminId,
    idempotencyKey: req.headers["idempotency-key"] ?? null,
    body: req.body,
  };
  const matches = [secrets.current, secrets.previous].some(
    (secret) => secret.trim() !== "" && secretsMatch(signature, signRequest(secret, parts)),
  );
  return matches ? { ok: true, adminId, nonce } : { ok: false, step: "signature" };
}
