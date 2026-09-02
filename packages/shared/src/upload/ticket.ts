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
  /** Epoch ms. Checked once, when the upload starts. */
  expiresAt: number;
  /**
   * How long the upload may go without a new part before the Durable Object
   * judges it dead. Signed in rather than configured on the Worker for the
   * same reason `partSize` is: the value lives in `config/storage.yaml`, which
   * the Worker cannot read, and a second copy in the Worker's own deployment
   * config is a second place for it to drift.
   */
  alarmIdleSeconds: number;
  /**
   * How long a token issued for the next part stays usable, in seconds. Signed
   * in for the same reason `alarmIdleSeconds` is: it lives in
   * `config/storage.yaml`, the Worker cannot read that file, and a second copy
   * inside the Worker is a second place for the value to drift — one whose
   * relation to the idle window nothing would then be checking.
   */
  sessionTokenTtlSeconds: number;
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
  if (now > read.payload.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, payload: read.payload };
}
