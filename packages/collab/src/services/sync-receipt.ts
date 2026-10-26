// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Connection, Document } from "@hocuspocus/server";
import type { SyncConfirmedResponse } from "@breatic/shared";

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
