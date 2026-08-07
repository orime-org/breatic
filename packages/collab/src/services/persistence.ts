// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * PostgreSQL persistence for Hocuspocus documents, and the single gate
 * deciding whether a store actually happens.
 *
 * Reads go through the shared `yjsDocumentsRepo` (Drizzle, over the core
 * `yjsDb` singleton) so the Yjs binary store keeps one home like every other
 * access to that table.
 *
 * WHY THIS IS NOT the stock `extension-database` ANY MORE (#40).
 * hocuspocus fires `onStoreDocument` after every edit and offers no setting
 * to stop it — `shouldSkipStoreHooks` returns false for connection-sourced
 * updates unconditionally, and raising `debounce` instead only strands
 * documents in memory, because `shouldUnloadDocument` is false the whole
 * time a store is pending. Storing has to be driven by the timed loop and
 * the unload gate alone, so the decision moves in here: no arm, no store.
 *
 * The stock extension could not host that decision. It encodes the entire
 * document before handing it to the write function, so an unarmed call would
 * still pay for a full encode of a document up to `max_document_bytes`
 * (10 MB) every couple of seconds.
 */

import type * as Y from "yjs";
import { encodeStateAsUpdate } from "yjs";
import { applyUpdate } from "yjs";
import { createLogger } from "@breatic/core";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";
import { lazySeedMeta } from "@collab/services/lazy-seed.js";
import {
  beginStore,
  commitStore,
  consumeTimedStoreArm,
} from "@collab/services/store-tracker.js";

const logger = createLogger("collab-persistence");

/**
 * Load a document's latest binary state.
 *
 * Soft-deleted rows read as absent (the repo filters `deleted_at`), so a
 * stale client reconnecting after its project was deleted cannot recover the
 * old content.
 *
 * Lazy-seed: a fresh project's `project-{id}/meta` doc has no row (create no
 * longer eager-seeds since the yjs store is a separate DB). On a null meta
 * fetch we seed one default canvas Space and return its bytes, so the
 * frontend never observes an empty project. Canvas docs are NOT seeded (they
 * start empty until first used).
 * @param args - Fetch payload.
 * @param args.documentName - Full Yjs doc name (the `yjs_documents.name` key).
 * @returns The stored (or freshly lazy-seeded) Yjs bytes, or null.
 */
export async function fetchDoc({
  documentName,
}: {
  documentName: string;
}): Promise<Uint8Array | null> {
  const existing = await yjsDocumentsRepo.fetchDocData(documentName);
  if (existing) return existing;
  return lazySeedMeta(documentName);
}

/**
 * Persist a document's binary state.
 *
 * The upsert clears `deleted_at`, so a store after a soft-delete would
 * resurrect the doc; in practice a soft-deleted project refuses WebSocket
 * auth before a store is ever reached (defense in depth).
 * @param args - Store payload.
 * @param args.documentName - Full Yjs doc name (the `yjs_documents.name` key).
 * @param args.state - Encoded Yjs update bytes to persist.
 */
export async function storeDoc({
  documentName,
  state,
}: {
  documentName: string;
  state: Uint8Array;
}): Promise<void> {
  await yjsDocumentsRepo.upsertDocData(documentName, state);
}

/** The document shape {@link storeDocumentNow} needs off the instance. */
export interface StorableDocument {
  name: string;
  getConnectionsCount(): number;
}

/**
 * Says who asked for this store, in a word the library does not recognise.
 *
 * @hocuspocus/extension-redis is the only reader of `lastTransactionOrigin`
 * anywhere in the library, and it reads it for one purpose: `afterStoreDocument`
 * waits `disconnectDelay` (1000ms by default) whenever the source is "local".
 * The library holds the document's save mutex across both store hooks, so
 * copying its own "local" origin cost every timed store a second of held mutex,
 * every round, forever — and a quarter of the whole shutdown budget on the way
 * out.
 *
 * That delay is for a direct connection disconnecting, where peers need a beat
 * to receive the sync before the document unloads. A timed store is not an
 * unload, and the delay that guards the actual unload — the Redis extension's
 * own `beforeUnloadDocument` — is untouched by this.
 *
 * `isTransactionOrigin` recognises only "connection", "redis" and "local", so
 * a source outside that set makes the check fall through. Naming it after
 * ourselves is what makes it obvious in a log where the store came from.
 */
const TIMED_STORE_ORIGIN = { source: "breatic-timed-store" } as const;

/** What {@link storeDocumentNow} hands the library's store entry. */
export interface StorePayload {
  instance: unknown;
  clientsCount: number;
  document: StorableDocument;
  documentName: string;
  lastContext: Record<string, unknown>;
  lastTransactionOrigin: typeof TIMED_STORE_ORIGIN;
}

/**
 * The part of the Hocuspocus instance {@link storeDocumentNow} drives.
 *
 * Named rather than inferred because the library ships duplicate copies of
 * its own types under pnpm hoisting, so the real instance does not satisfy an
 * import of them. Spelling out exactly the two members used keeps the call
 * checked instead of casting the whole object away.
 */
export interface StoreDriver {
  documents: Map<string, StorableDocument>;
  storeDocumentHooks(
    document: StorableDocument,
    payload: StorePayload,
    immediately?: boolean,
  ): unknown;
}

/**
 * Ask hocuspocus to store one document right now.
 *
 * Goes through the library's own store entry rather than writing directly,
 * which is what makes the timed loop and the unload gate inherit two things
 * they cannot reproduce: the per-document mutex that keeps two writes of one
 * document from overlapping, and the re-check that unloads a document whose
 * last connection went away mid-write. A direct write would strand such a
 * document in memory with zero connections and nothing left to release it.
 *
 * It does not throw and its resolution says nothing about success — the
 * library swallows store errors. Whether the content landed is answered by
 * the tracker's counters.
 * @param driver - The Hocuspocus instance.
 * @param documentName - Full Yjs document name.
 */
export async function storeDocumentNow(
  driver: StoreDriver,
  documentName: string,
): Promise<void> {
  const document = driver.documents.get(documentName);
  if (!document) return;
  await driver.storeDocumentHooks(
    document,
    {
      instance: driver,
      clientsCount: document.getConnectionsCount(),
      document,
      documentName,
      lastContext: {},
      lastTransactionOrigin: TIMED_STORE_ORIGIN,
    },
    true,
  );
}

/** Collaborators the extension needs, overridable so tests can count them. */
export interface PersistenceDeps {
  /** Read a document's stored bytes. */
  fetch(args: { documentName: string }): Promise<Uint8Array | null>;
  /** Write a document's bytes. */
  store(args: { documentName: string; state: Uint8Array }): Promise<void>;
  /** Turn a live document into the bytes to store. */
  encode(document: Y.Doc): Uint8Array;
}

/** The two hooks hocuspocus drives persistence through. */
export interface PersistenceExtension {
  onLoadDocument(args: { documentName: string; document: Y.Doc }): Promise<void>;
  onStoreDocument(args: { documentName: string; document: Y.Doc }): Promise<void>;
}

/**
 * Build the persistence extension.
 * @param deps - Overridable collaborators; defaults hit the real repo.
 * @returns The hooks to register on the Hocuspocus server.
 */
export function createPersistenceExtension(
  deps: Partial<PersistenceDeps> = {},
): PersistenceExtension {
  const fetch = deps.fetch ?? fetchDoc;
  const store = deps.store ?? storeDoc;
  const encode = deps.encode ?? ((document: Y.Doc): Uint8Array => encodeStateAsUpdate(document));

  return {
    onLoadDocument: async ({ documentName, document }): Promise<void> => {
      const update = await fetch({ documentName });
      if (update) applyUpdate(document, update);
    },

    onStoreDocument: async ({ documentName, document }): Promise<void> => {
      // No arm means hocuspocus started this itself, after an edit. Return
      // before encoding: the whole point is that only the timed loop and the
      // unload gate write.
      if (!consumeTimedStoreArm(documentName)) return;

      // Snapshot BEFORE the encode, so anything typed during the write still
      // reads as unsaved when it returns.
      const ticket = beginStore(documentName);
      const state = encode(document);

      try {
        await store({ documentName, state });
        commitStore(documentName, ticket);
      } catch (err) {
        // Deliberately not rethrown. Letting it escape makes hocuspocus skip
        // `afterStoreDocument`, which leaves the cross-instance lock held
        // until its TTL and skips the re-check that unloads a document whose
        // last connection went away mid-write. Correctness lives in the
        // counters, which stay untouched on failure — so the next round, and
        // the unload gate, both still see this content as outstanding.
        logger.error({ err, documentName, bytes: state.length }, "collab_store_failed");
      }
    },
  };
}
