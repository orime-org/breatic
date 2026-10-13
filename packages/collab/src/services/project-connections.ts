// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Closing every connection this instance holds on one project (inner#1497 §6.2).
 *
 * Run by every instance when the project's `connections:close` control event
 * arrives. Hocuspocus closes one document of a shared socket with a CLOSE
 * message that carries only the reason, and the client sees the code as 1000.
 * So the REASON is the contract: for the reasons in the web client's
 * re-authenticate list it re-sends its token for that document on the same
 * socket, and `onAuthenticate` decides the outcome — an archived project comes
 * back read-only, a restored one writable, a duplicated one re-loads its
 * now-correct meta.
 */

import type { Connection, Hocuspocus } from "@hocuspocus/server";
import {
  COLLAB_REAUTH_REASONS,
  parseDocName,
  type ProjectConnectionsCloseReason,
} from "@breatic/shared";

/** The close frame for each reason. */
const CLOSE_FRAMES: Record<ProjectConnectionsCloseReason, { code: number; reason: string }> = {
  "content-updated": { code: 4406, reason: COLLAB_REAUTH_REASONS.projectContentUpdated },
  archived: { code: 4407, reason: COLLAB_REAUTH_REASONS.projectArchived },
  restored: { code: 4408, reason: COLLAB_REAUTH_REASONS.projectRestored },
};

/**
 * Visit every connection this instance holds to any document of a project.
 *
 * Walks the loaded-document map and filters by the project id in the document
 * name, so the meta document and every Space document are covered. A
 * document that is not loaded here has no connections here.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param projectId - The project.
 * @param visit - Called once per connection.
 */
export function forEachProjectConnection(
  hocuspocus: Hocuspocus,
  projectId: string,
  visit: (connection: Connection) => void,
): void {
  const docs = hocuspocus.documents;
  if (!docs) return;
  for (const [docName, doc] of docs.entries()) {
    const parsed = parseDocName(docName);
    if (!parsed || parsed.projectId !== projectId) continue;
    // The connection IS the map key from v4 on (the value only carries the
    // client-id set).
    for (const [connection] of doc.connections) visit(connection);
  }
}

/**
 * Close every connection to any document of a project on this instance.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param projectId - The project.
 * @param reason - Why; picks the close frame.
 * @returns False when the reason names no close frame, and nothing was closed.
 */
export function closeProjectConnections(
  hocuspocus: Hocuspocus,
  projectId: string,
  reason: ProjectConnectionsCloseReason,
): boolean {
  const frame = CLOSE_FRAMES[reason];
  if (!frame) return false;
  forEachProjectConnection(hocuspocus, projectId, (connection) => {
    connection.close({ code: frame.code, reason: frame.reason });
  });
  return true;
}
