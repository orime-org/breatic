// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When each project was last edited.
 *
 * Lives in core because two services write it: collab, after a Space
 * document's store lands or a Space is created, renamed, locked, deleted or
 * restored; and the server, with a rename, description or cover change.
 */

import { sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import type { DbTx } from "@core/db/client.js";
import { projectEdits } from "@core/db/schema.js";

/**
 * Record that a project was edited now.
 * @param projectId - The project that changed.
 * @param executor - The transaction to write in, so the record goes with the
 *   change it describes; the shared pool when omitted.
 * @returns Resolves once the row is written.
 */
export async function touchProjectEdit(
  projectId: string,
  executor: DbTx | typeof db = db,
): Promise<void> {
  await executor
    .insert(projectEdits)
    .values({ projectId })
    .onConflictDoUpdate({
      target: projectEdits.projectId,
      set: { lastEditedAt: sql`now()` },
    });
}
