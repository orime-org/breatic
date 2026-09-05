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
 * It is re-issued with every part, and every re-issue starts its window over,
 * so the window only has to cover the gap between two parts rather than the
 * whole upload — which is why a slow 2 GiB upload never needs a long-lived
 * credential. Carrying the remaining life forward instead would make the
 * window a ceiling on the upload as well.
 *
 * It carries the signed part layout for the same reason it carries the upload
 * id: the Worker is in front of the bytes and has to judge a part before it
 * writes one, and everything it judges by has to be something the browser
 * cannot alter.
 */

/** What a session token says. */
export interface SessionTokenPayload extends PartLayout {
  /** The upload it may write into. */
  storageKey: string;
  /** R2's own id for the multipart upload. */
  uploadId: string;
  /**
   * What the ticket said these bytes are. It is written onto the R2 object
   * when the upload opens and reported back when it finishes, and it rides
   * here for the same reason the key does: the Worker holds nothing between
   * requests, and everything it acts on has to be something the browser
   * cannot alter.
   */
  contentType: string;
  /**
   * How long a token lasts, in seconds, as the ticket signed it.
   *
   * It rides here so that the next re-issue can start a fresh window without
   * this Worker holding a copy of the figure — the value lives in
   * `config/storage.yaml`, which checks it against the other windows, and a
   * second copy here would be a second place for it to drift out of that
   * relation.
   */
  sessionTokenTtlSeconds: number;
  /** Epoch ms after which it is refused. */
  expiresAt: number;
}

import { signPayload, readSignedPayload } from "@breatic/shared";
import type { PartLayout } from "@ingest/part-layout.js";

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
  return signPayload(payload, secret);
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
  const read = await readSignedPayload<SessionTokenPayload>(token, secret);
  if (!read.ok) return null;
  if (now > read.payload.expiresAt) return null;
  return read.payload;
}
