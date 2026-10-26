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
  /** Written into the R2 object's httpMetadata. */
  contentType: string;
  /**
   * Take the type from what the source's response declares, and refuse the
   * transfer when that is not an uploadable kind.
   *
   * Set only on the lane where a caller hands us an address: it has no bytes
   * to declare a type from, so `contentType` above is a placeholder there and
   * the source's own answer is the only truthful value. Every other lane
   * leaves this unset and keeps the type its ticket signed — a task type's
   * output is decided before a byte moves, and the key's extension is decided
   * from the same place.
   */
  typeFromSource?: boolean;
  /** Epoch ms. Checked once, when the upload starts. */
  expiresAt: number;
  /**
   * When the task this upload belongs to runs out, in epoch ms (inner#1367).
   * Every session token issued for it expires then: the upload is bounded by
   * its task's deadline and nothing else.
   */
  deadlineAt: number;
}

/** Why a ticket did not verify. */
export type UploadTicketRejection = "malformed" | "bad_signature" | "expired";

/** Outcome of verifying a ticket. */
export type UploadTicketVerification =
  | { ok: true; payload: UploadTicketPayload }
  | { ok: false; reason: UploadTicketRejection };

import {
  signPayload,
  readSignedPayload,
  isFilled,
} from "@shared/upload/signed-payload.js";

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
  return signPayload(payload, secret);
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
  const read = await readSignedPayload<UploadTicketPayload>(token, secret);
  if (!read.ok) return read;
  if (!isTicketShaped(read.payload)) return { ok: false, reason: "malformed" };
  if (now > read.payload.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, payload: read.payload };
}

/**
 * Whether a signed payload is a ticket rather than a session token.
 *
 * Both are signed with the same secret, so a valid signature does not say
 * which one arrived. A session token always names an `uploadId` and a ticket
 * never does, and only a ticket names who asked for it; requiring both keeps
 * either from passing as the other (RFC 8725 §3.12, inner#1595).
 * @param payload - The payload a valid signature covered.
 * @returns True when it has a ticket's identity fields and no upload id.
 */
function isTicketShaped(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    !("uploadId" in p) &&
    isFilled(p.storageKey) &&
    isFilled(p.userId) &&
    isFilled(p.studioId)
  );
}
