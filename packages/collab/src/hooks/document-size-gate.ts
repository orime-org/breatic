// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size cap's hooks (inner#1790, design 4.2 and 4.3): the judgement
 * `beforeSync` makes on each sync message of a writable connection, and the
 * transaction listeners that refuse an applied client update which left new
 * pending content behind.
 *
 * The judgement reads only the record's current size, the phase the
 * connection last acknowledged and the update's shape, synchronously, so
 * connections judged one after another see what the ones before them added.
 * A message `beforeSync` refuses is not applied: the gate marks the socket and
 * document refused, closes that document's connection with the size-limit
 * reason and throws, and Hocuspocus drops what the connection had queued. A
 * refusal by the transaction listeners comes after the update applied and
 * does not throw, so what is already queued behind it reaches step 0 and is
 * refused there. Either way the inbound filter drops later frames until the
 * client authenticates the document again. A connection already out of the
 * document (closed meanwhile, its queue still draining) is refused unmarked:
 * the mark is per socket and document, so it would land on the socket's next
 * connection to the document, or outlive a closed socket.
 */

import type { beforeSyncPayload, Connection, Document } from "@hocuspocus/server";
import { messageYjsSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";
import { createLogger } from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, DOC_SIZE_ACK_PARAM, DOC_SIZE_EVENT_BYTES, updateShape, type UpdateShape } from "@breatic/shared";
import { getCollabConfig } from "@collab/config.js";
import type { AuthContext } from "@collab/hooks/auth.js";
import { userIdOf } from "@collab/hooks/presence-wiring.js";
import { isRefused, markRefused } from "@collab/infra/inbound-filter.js";
import { admit, knowsFull, readDocSizeRecord, release, scheduleMeasure } from "@collab/services/document-size.js";

const logger = createLogger("document-size-gate");

/** Why a message was refused, as the refusal log names it. */
type RefusalStep = "after_refusal" | "splits" | "pending" | "full" | "over_ceiling" | "error";

/**
 * The limit and the hard ceiling the configuration sets.
 * @returns Both, in bytes.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function limitAndCeiling(): { limit: number; ceiling: number } {
  const cfg = getCollabConfig();
  return { limit: cfg.max_document_bytes, ceiling: cfg.max_document_bytes + cfg.document_size_delete_headroom_bytes };
}

/** The clocks a store's pending content covers, structs and delete set apart. */
interface PendingCoverage {
  structs: number;
  ds: number;
}

/**
 * Log one refusal with the fields design 4.2 names; a step 2a refusal adds
 * the pending coverage before and after the transaction.
 * @param documentName - The document.
 * @param userId - Whose message it was.
 * @param step - Why.
 * @param pending - The pending coverage before and after, for step 2a.
 * @param pending.pendingBefore - Before the transaction.
 * @param pending.pendingAfter - After it.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function logRefusal(
  documentName: string,
  userId: string | undefined,
  step: RefusalStep,
  pending?: { pendingBefore: PendingCoverage; pendingAfter: PendingCoverage },
): void {
  const { limit, ceiling } = limitAndCeiling();
  const current = readDocSizeRecord(documentName)?.current ?? 0;
  logger.warn({ documentName, userId, current, limit, ceiling, step, ...pending }, "document_size_limit_refused");
}

/**
 * What an update costs the record (design 4.1).
 * @param update - The update.
 * @param shape - Its shape.
 * @returns Bytes.
 */
function costOf(update: Uint8Array, shape: UpdateShape): number {
  const events = shape.splitEndpoints + shape.beyondClockRanges;
  // A delete set covering only deleted content, such as a member's handshake
  // SyncStep2, leaves the document as it was.
  if (shape.pureDelete && !shape.coversLive && events === 0) return 0;
  return update.byteLength + DOC_SIZE_EVENT_BYTES * events;
}

/**
 * Whether a connection comes from a page that does not handle the
 * size-limit close: it opened its WebSocket without `size_ack=1`.
 * @param connection - The connection.
 * @returns True for such a page.
 */
function isOldPage(connection: Connection): boolean {
  return new URL(connection.request.url, "http://collab").searchParams.get(DOC_SIZE_ACK_PARAM) !== "1";
}

/**
 * Close a refused connection with the size-limit reason; an old page's whole
 * WebSocket is closed after it, so its provider reconnects.
 * @param connection - The refused connection, still in the document.
 */
function closeForSize(connection: Connection): void {
  connection.close({ code: 1000, reason: COLLAB_DOCUMENT_TOO_LARGE_REASON });
  if (isOldPage(connection)) connection.webSocket.close();
}

/**
 * Build the size judgement `beforeSync` runs before the activity record.
 * @returns The judgement; it returns to admit and throws to refuse.
 */
export function createDocumentSizeGate(): (data: beforeSyncPayload<AuthContext>) => void {
  return (data): void => {
    const { documentName, document, connection, type, payload } = data;
    const userId = userIdOf(data);

    /**
     * Refuse the message.
     * @param step - Why.
     * @throws {Error} Always, carrying the size-limit close reason.
     */
    const refuse = (step: RefusalStep): never => {
      if (document.hasConnection(connection)) {
        markRefused(connection.socketId, documentName);
        closeForSize(connection);
      }
      logRefusal(documentName, userId, step);
      throw Object.assign(new Error("document size limit reached"), { reason: COLLAB_DOCUMENT_TOO_LARGE_REASON });
    };

    if (isRefused(connection.socketId, documentName)) refuse("after_refusal");
    const record = readDocSizeRecord(documentName);
    if (!record || connection.readOnly || type === messageYjsSyncStep1) return;

    let shape: UpdateShape;
    try {
      shape = updateShape(payload, document.store);
    } catch (err) {
      logger.error({ err, ctx: { documentName, userId } }, "document_size_gate_failed");
      return refuse("error");
    }
    const cfg = getCollabConfig();
    const { limit, ceiling } = limitAndCeiling();
    // A message is judged by the phase its connection had acknowledged when
    // it sent it; the hard ceiling holds whatever the connection had seen.
    const bound = record.current >= ceiling || (record.current >= limit && knowsFull(documentName, connection));
    if (bound && shape.splitEndpoints > cfg.document_size_max_delete_splits) refuse("splits");
    if (bound && record.current < ceiling && !shape.pureDelete) refuse("full");
    if (record.current >= ceiling && !(shape.pureDelete && shape.beyondClockRanges === 0 && shape.wholeTypesOnly)) {
      refuse("over_ceiling");
    }
    admit(documentName, connection, costOf(payload, shape));
  };
}

/** The pending content of a store, kept by value before a transaction. */
interface PendingSnapshot {
  structs: { update: Uint8Array; missing: Map<number, number> } | null;
  ds: Uint8Array | null;
}

/**
 * The clocks pending structs cover: their lengths, `Skip` gaps excluded.
 * @param update - `pendingStructs.update` (V2), or null.
 * @returns Clocks.
 * @throws {Error} When the update cannot be decoded.
 */
function structsCoverage(update: Uint8Array | null): number {
  if (update === null) return 0;
  return Y.decodeUpdateV2(update).structs.reduce((sum, st) => sum + (st instanceof Y.Skip ? 0 : st.length), 0);
}

/**
 * The clocks a pending delete set covers: the sum of its ranges' lengths.
 * @param ds - `pendingDs` (V2), or null.
 * @returns Clocks.
 * @throws {Error} When the update cannot be decoded.
 */
function dsCoverage(ds: Uint8Array | null): number {
  if (ds === null) return 0;
  let n = 0;
  Y.decodeUpdateV2(ds).ds.clients.forEach((ranges) => {
    for (const r of ranges) n += r.len;
  });
  return n;
}

/**
 * Whether two byte arrays hold the same bytes.
 * @param a - One, or null.
 * @param b - The other, or null.
 * @returns True when both are null or byte for byte equal.
 */
function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.byteLength !== b.byteLength) return false;
  return a.every((byte, i) => byte === b[i]);
}

/**
 * The client connection a transaction came from, if it did.
 * @param origin - The transaction's origin.
 * @returns The connection, or null for any other origin.
 */
function connectionOf(origin: unknown): Connection | null {
  const o = origin as { source?: unknown; connection?: Connection } | null;
  return o?.source === "connection" && o.connection ? o.connection : null;
}

/**
 * Watch a recorded document's transactions: a client update that left the
 * store's pending content covering more clocks than before is refused by
 * value (design 4.2 step 2a), every applied client update releases its
 * held cost, and every transaction schedules a measure.
 * @param document - The loaded document; its record must exist.
 */
export function watchDocumentSize(document: Document): void {
  const name = document.name;
  const before = new WeakMap<Y.Transaction, PendingSnapshot>();
  document.on("beforeTransaction", (transaction: Y.Transaction) => {
    if (connectionOf(transaction.origin) === null) return;
    const { pendingStructs, pendingDs } = document.store;
    before.set(transaction, {
      structs: pendingStructs ? { update: pendingStructs.update, missing: new Map(pendingStructs.missing) } : null,
      ds: pendingDs,
    });
  });
  document.on("afterTransaction", (transaction: Y.Transaction) => {
    const connection = connectionOf(transaction.origin);
    const snapshot = before.get(transaction);
    if (connection !== null && snapshot !== undefined) {
      const { store } = document;
      // yjs replaces `update` whenever it merges into the pending structs and
      // writes a fresh `pendingDs` on every transaction, so an unchanged value
      // is told apart without decoding; a changed one is compared by the
      // clocks it covers, as yjs re-encodes it with absolute clocks.
      const structsBefore = snapshot.structs?.update ?? null;
      const structsAfter = store.pendingStructs?.update ?? null;
      const structs = structsAfter === structsBefore ? null : [structsCoverage(structsBefore), structsCoverage(structsAfter)] as const;
      const ds = sameBytes(store.pendingDs, snapshot.ds) ? null : [dsCoverage(snapshot.ds), dsCoverage(store.pendingDs)] as const;
      if ((structs !== null && structs[1] > structs[0]) || (ds !== null && ds[1] > ds[0])) {
        const pendingBefore = { structs: structsCoverage(structsBefore), ds: dsCoverage(snapshot.ds) };
        const pendingAfter = { structs: structsCoverage(structsAfter), ds: dsCoverage(store.pendingDs) };
        store.pendingStructs = snapshot.structs;
        store.pendingDs = snapshot.ds;
        if (document.hasConnection(connection)) {
          markRefused(connection.socketId, name);
          closeForSize(connection);
        }
        logRefusal(name, (connection.context as AuthContext | undefined)?.user?.id, "pending", { pendingBefore, pendingAfter });
      }
      release(name, connection);
    }
    scheduleMeasure(name);
  });
}
