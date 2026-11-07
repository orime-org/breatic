// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size cap's hooks (inner#1790, design 4.2 and 4.3): the judgement
 * `beforeSync` makes on each sync message of a writable connection, and the
 * transaction listeners that refuse an applied client update which left new
 * pending content behind.
 *
 * The judgement reads only the record's current size and the update's shape,
 * synchronously, so connections judged one after another see what the ones
 * before them added. A refused message is not applied and Hocuspocus closes
 * that document's connection with the error's reason; the inbound filter then
 * drops, and step 0 refuses, what the client had already queued behind it
 * until it authenticates the document again.
 */

import type { beforeSyncPayload, Connection, Document } from "@hocuspocus/server";
import { messageYjsSyncStep1 } from "y-protocols/sync";
import type * as Y from "yjs";
import { createLogger } from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, DOC_SIZE_EVENT_BYTES, updateShape, type UpdateShape } from "@breatic/shared";
import { getCollabConfig } from "@collab/config.js";
import type { AuthContext } from "@collab/hooks/auth.js";
import { userIdOf } from "@collab/hooks/presence-wiring.js";
import { isRefused, markRefused } from "@collab/infra/inbound-filter.js";
import { admit, readDocSizeRecord, release, scheduleMeasure } from "@collab/services/document-size.js";

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

/**
 * Log one refusal with the fields design 4.2 names.
 * @param documentName - The document.
 * @param userId - Whose message it was.
 * @param step - Why.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function logRefusal(documentName: string, userId: string | undefined, step: RefusalStep): void {
  const { limit, ceiling } = limitAndCeiling();
  const current = readDocSizeRecord(documentName)?.current ?? 0;
  logger.warn({ documentName, userId, current, limit, ceiling, step }, "document_size_limit_refused");
}

/**
 * What an update costs the record (design 4.1).
 * @param shape - The update's shape.
 * @returns Bytes.
 */
function costOf(shape: UpdateShape): number {
  return shape.structBytes + DOC_SIZE_EVENT_BYTES * (shape.splitEndpoints + shape.beyondClockRanges);
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
      markRefused(connection.socketId, documentName);
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
    if (shape.splitEndpoints > cfg.document_size_max_delete_splits) refuse("splits");
    if (record.current >= limit && record.current < ceiling && !shape.pureDelete) refuse("full");
    if (record.current >= ceiling && !(shape.pureDelete && shape.beyondClockRanges === 0 && shape.wholeTypesOnly)) {
      refuse("over_ceiling");
    }
    admit(documentName, connection, costOf(shape));
  };
}

/** The pending content of a store, kept by value before a transaction. */
interface PendingSnapshot {
  structs: { update: Uint8Array; missing: Map<number, number> } | null;
  structsLength: number;
  ds: Uint8Array | null;
  dsLength: number;
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
 * store's pending content longer than before is refused by value (design
 * 4.2 step 2a), every applied client update releases its held cost, and
 * every transaction schedules a measure.
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
      structsLength: pendingStructs?.update.byteLength ?? 0,
      ds: pendingDs,
      dsLength: pendingDs?.byteLength ?? 0,
    });
  });
  document.on("afterTransaction", (transaction: Y.Transaction) => {
    const connection = connectionOf(transaction.origin);
    const snapshot = before.get(transaction);
    if (connection !== null && snapshot !== undefined) {
      const { store } = document;
      const grew = (store.pendingStructs?.update.byteLength ?? 0) > snapshot.structsLength
        || (store.pendingDs?.byteLength ?? 0) > snapshot.dsLength;
      if (grew) {
        store.pendingStructs = snapshot.structs;
        store.pendingDs = snapshot.ds;
        markRefused(connection.socketId, name);
        connection.close({ code: 1000, reason: COLLAB_DOCUMENT_TOO_LARGE_REASON });
        logRefusal(name, (connection.context as AuthContext | undefined)?.user?.id, "pending");
      }
      release(name, connection);
    }
    scheduleMeasure(name);
  });
}
