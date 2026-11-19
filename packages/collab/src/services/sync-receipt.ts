// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Connection, Document } from "@hocuspocus/server";
import type { DocKind, SyncConfirmedResponse } from "@breatic/shared";

/**
 * Answers the barrier after earlier messages on this content Connection applied.
 * @param document - Content document that received the request.
 * @param connection - Requesting authenticated connection.
 * @param id - Validated correlation identifier.
 * @throws {Error} When sending the response fails.
 */
export function replySyncConfirmation(document: Document, connection: Connection, id: string): void {
  if (!document.hasConnection(connection)) return;
  connection.sendStateless(JSON.stringify({
    type: "sync:confirmed", id, ok: !connection.readOnly,
  } satisfies SyncConfirmedResponse));
}

/** Content documents whose unsynced edits the page counts before it lets the user leave. */
const CONFIRMING: ReadonlySet<DocKind> = new Set<DocKind>(["canvas", "document", "web_animation"]);

/**
 * Whether a document of this kind answers a sync confirmation (#1490 design §3.3).
 * @param kind - The document's kind.
 * @returns True for canvas, Document and Motion content documents.
 * @throws {never} Never.
 */
export function confirmsSync(kind: DocKind): boolean {
  return CONFIRMING.has(kind);
}
