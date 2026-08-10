// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which Spaces a project has right now, read from the meta doc this process
 * holds (#26).
 *
 * This lives beside the other collab services rather than inside the auth
 * hook because the question — "what Spaces does this project have" — is not
 * about authentication. The hook is one caller; the integration test that
 * runs two instances is another, and it has to be able to call the same
 * function rather than a copy of it.
 */

import type * as Y from "yjs";
import { createLogger } from "@breatic/core";
import { projectMetaDocName } from "@breatic/shared";

const logger = createLogger("collab-project-space-list");

/**
 * The slice of the Hocuspocus instance this needs: the table of documents
 * this process holds, and the two calls that put one in it and take it back
 * out. Naming only what is used keeps this out of the rest of the
 * framework's surface. Written with method syntax so a real `Hocuspocus`,
 * whose documents are `Document` rather than bare `Y.Doc`, satisfies it.
 */
export interface DocumentRegistry {
  documents: { get(documentName: string): Y.Doc | undefined };
  createDocument(
    documentName: string,
    request: Request,
    socketId: string,
    connection: { isAuthenticated: boolean; readOnly: boolean },
  ): Promise<Y.Doc>;
  unloadDocument(document: Y.Doc): Promise<unknown>;
}

/**
 * Unload a meta doc this read loaded, after the caller has its answer.
 *
 * Loading and unloading are paired here: this function loaded the document,
 * so this function takes it back out. A document loaded without a connection
 * is never unloaded on its own — `unloadDocument` is only reached from a
 * closing client connection or a finishing store — so skipping this leaks a
 * document per project, and `Server.destroy()`, which waits for the document
 * count to reach zero, never finishes. Measured, not reasoned: an
 * integration test hung on exactly that.
 *
 * NOT awaited. The unload costs about a second — `@hocuspocus/extension-redis`
 * delays its `beforeUnloadDocument` by `disconnectDelay` (1000ms by default,
 * `hocuspocus-redis.cjs:48`) so peers have a beat to receive the last sync —
 * and that is housekeeping, not something the caller waiting on an answer
 * should pay for. Hocuspocus re-checks whether the document is still
 * unloadable at the start (`shouldUnloadDocument`) and again mid-flight, so a
 * client connecting in the meantime — the normal case on a reconnect —
 * cancels it. Two concurrent reads that both loaded do not double-unload
 * either: the second call returns the first one's in-flight promise.
 * @param instance - The running Hocuspocus server.
 * @param document - The document this read loaded.
 * @param documentName - Name of that document, for the log line.
 */
function unloadAfterReading(
  instance: DocumentRegistry,
  document: Y.Doc,
  documentName: string,
): void {
  void instance.unloadDocument(document).catch((err: unknown) => {
    logger.warn({ err, documentName }, "meta_doc_unload_after_read_failed");
  });
}

/**
 * The Space ids this project currently has, read from the meta doc this
 * process holds — making sure it holds one first.
 *
 * IT ANSWERS FROM THE LIST ITSELF, NOT FROM A COPY OF IT (#26). `space:create`
 * writes the new id into the in-memory meta doc and broadcasts that doc; the
 * `yjs_documents` row trails behind by up to one `store_interval_ms` tick,
 * because the create path triggers no store of its own. Deciding from storage
 * therefore refused connections to Spaces this very process had just
 * announced. `space:delete` is the mirror image: the id leaves memory at once
 * while storage keeps admitting connections until the next tick.
 *
 * Whether the in-memory list is itself up to date does not enter into it:
 * whatever it holds is what the clients here were told, so answering from it
 * is what keeps the answer consistent with the announcement. Keeping it
 * current is `@hocuspocus/extension-redis`'s job, not this function's.
 *
 * WHEN THIS PROCESS HOLDS NONE, IT LOADS ONE. That is not a fallback, it is
 * the same answer reached the same way: `createDocument` runs the persistence
 * extension (which reads `yjs_documents`, and seeds a first Space through
 * `lazySeedMeta` when there is no row yet) and then the peer sync, and hands
 * back the one copy everyone else on this process uses — deduplicated by
 * document name, so a burst of handshakes loads it once. Measured across two
 * instances: 9-16ms, and it saw a Space that existed only in the other
 * instance's memory.
 *
 * That load runs the whole chain, and one link on it writes: `lazySeedMeta`
 * creates a project's first Space when no row is stored yet. Nothing defends
 * against that. It is the same seed the project's own first meta-doc load
 * performs, it is idempotent (deterministic id, `ON CONFLICT DO NOTHING`),
 * and reaching this path at all means being a member who could have
 * triggered it by opening the project — the browser never can, because it
 * learns Space ids from the meta doc it would have had to open first.
 *
 * The reason this matters is the RECONNECT: a client that has already synced
 * holds the meta doc in its own memory, so when the socket comes back it asks
 * for every open Space's content doc in the same millisecond as the meta doc,
 * and those handshakes run before the meta doc is loaded here. That is where
 * nearly every refusal in the logs came from.
 *
 * A loaded list holding zero Spaces is a verdict, not an absence — this
 * project has no Spaces right now. There is no second source to fall through
 * to, which is the point: one list, one answer.
 * @param projectId - Project whose meta Yjs doc holds `meta.spaces`.
 * @param instance - The running Hocuspocus server, for the document it holds or can load.
 * @param request - The upgrade request, passed through to the load hooks.
 * @param socketId - The requesting connection's socket id, passed through on the same path.
 * @returns The Space ids currently listed in `meta.spaces`.
 */
export async function readProjectSpaceIds(
  projectId: string,
  instance: DocumentRegistry,
  request: Request,
  socketId: string,
): Promise<Set<string>> {
  const docName = projectMetaDocName(projectId);

  const held = instance.documents.get(docName);
  if (held) return new Set(held.getMap("spaces").keys());

  // Read-only: this never writes to the document, and the flag travels into
  // the load hooks as the reason it is being opened.
  const loaded = await instance.createDocument(docName, request, socketId, {
    isAuthenticated: true,
    readOnly: true,
  });
  const ids = new Set(loaded.getMap("spaces").keys());
  unloadAfterReading(instance, loaded, docName);
  return ids;
}
