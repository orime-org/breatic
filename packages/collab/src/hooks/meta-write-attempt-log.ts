// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Decide whether an incoming frame looks like a client trying to write the
 * project meta doc, so the application layer can log it.
 *
 * That doc is read-only for every client (`hooks/auth.ts`), and nothing in
 * the frontend writes it any more — Space lifecycle and tab changes all go
 * through `space:*` / `tab:*` RPCs. So this should never fire in normal
 * operation, and a line in the log means a stale build or someone probing.
 *
 * ## This decides whether to LOG, never whether to ALLOW
 *
 * Refusing the write is the framework's job. Hocuspocus checks the
 * connection's read-only flag at each site that applies an update, so a
 * write is refused whether or not this function noticed it.
 *
 * That split is deliberate, and it is why this file is allowed to exist at
 * all. It replaces a gate that had to be exhaustive about the framework's
 * internal message types in order to be correct — and it was not: it
 * missed the document-name prefix that every real frame carries, so it
 * never ran once in production, and even patched it would still have let
 * two other message shapes through. Being exhaustive about someone else's
 * wire format is a losing game when the cost of missing one is "the guard
 * silently does nothing". Here the cost of being wrong is one log line
 * more or one less.
 *
 * ## What it deliberately does not catch
 *
 * Only the `Update` sub-type is reported. A client can also carry changes
 * in `SyncStep2`, but every client sends that on every connect as part of
 * the handshake, and telling an ordinary handshake apart from one that
 * happens to carry a change would mean applying the update to a clone and
 * diffing it — the expensive, fragile machinery this file exists to be rid
 * of. Missing that path costs a log line; it does not let a write through.
 */

import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

/** Hocuspocus outer message types that carry a Yjs sync payload. */
const SYNC_MESSAGE_TYPES = new Set([0, 4]); // Sync, SyncReply

/** Marker used by collab's own privileged writers. */
const SYSTEM_USER_ID = "system";

/**
 * Whether this frame is a client attempting to change the meta doc.
 *
 * Never throws: a malformed frame simply is not reported. Deciding
 * whether to log must not be able to break a connection.
 * @param documentName - Name of the doc the frame is addressed to.
 * @param update - Raw Hocuspocus frame, exactly as it arrived — including
 *   the document-name prefix that multiplexing puts in front of every
 *   message. Reading past that prefix is not optional; skipping it makes
 *   the message type read back as the name's byte length.
 * @param context - Connection context; `system` is collab's own writer.
 * @returns True when a client is trying to write the meta doc.
 */
export function isMetaWriteAttempt(
  documentName: string,
  update: Uint8Array,
  context: { user?: { id?: string } },
): boolean {
  if (!documentName.endsWith("/meta")) return false;
  if (context.user?.id === SYSTEM_USER_ID) return false;

  try {
    const decoder = decoding.createDecoder(update);
    // The document name comes first on the wire — read it and discard it.
    decoding.readVarString(decoder);
    const messageType = decoding.readVarUint(decoder);
    if (!SYNC_MESSAGE_TYPES.has(messageType)) return false;
    const syncSubType = decoding.readVarUint(decoder);
    return syncSubType === syncProtocol.messageYjsUpdate;
  } catch {
    return false;
  }
}
