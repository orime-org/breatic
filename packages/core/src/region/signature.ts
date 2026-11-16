// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The internal API request signature (inner#1410 §4.2), written once for the
 * side that signs (the back office, other regions) and the side that checks
 * (`packages/server/src/middleware/internal-signature.ts`).
 *
 * The signed text is seven lines joined by `\n`: method, path with its query
 * string as sent, timestamp, nonce, admin id, the `Idempotency-Key` header
 * (an empty line when absent) and the raw body. The idempotency key is signed
 * because it decides which disposition a request replays; changing it is
 * starting a different one.
 */

import { createHmac } from "node:crypto";

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
 * Sign a request for the internal API.
 * @param secret - The shared secret.
 * @param parts - The seven signed values.
 * @returns `v1=` plus the lowercase hex HMAC-SHA256.
 */
export function signRequest(secret: string, parts: SignedParts): string {
  return `v1=${createHmac("sha256", secret).update(canonicalString(parts), "utf8").digest("hex")}`;
}
