// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { beforeSyncPayload } from "@hocuspocus/server";
import { messageYjsUpdate } from "y-protocols/sync";
import { decodeUpdate } from "yjs";
import { accountActivityRepo, createLogger } from "@breatic/core";
import { parseDocName } from "@breatic/shared";
import type { AuthContext } from "@collab/hooks/auth.js";

const logger = createLogger("account-activity");

/**
 * Admit authenticated writable content updates before native sync applies them.
 * @returns The native beforeSync callback, excluding handshake and meta frames.
 * @throws {Error} When decoding or persisting an admitted mutation fails.
 */
export function createActivityHook(): (data: beforeSyncPayload<AuthContext>) => Promise<void> {
  return async ({ documentName, context, connection, type, payload }): Promise<void> => {
    const parsed = parseDocName(documentName);
    if (!parsed || parsed.kind === "meta" || connection.readOnly || type !== messageYjsUpdate) return;
    const userId = context.user?.id;
    if (!userId) return;
    try {
      const update = decodeUpdate(payload);
      if (update.structs.length === 0 && update.ds.clients.size === 0) return;
      await accountActivityRepo.recordActivity({ userId, projectId: parsed.projectId, kind: "project_edit" });
    } catch (err) {
      logger.error({ err: err instanceof Error && err.cause instanceof Error ? err.cause : err,
        ctx: { operation: "admit_content_update", userId, projectId: parsed.projectId, documentName } }, "Content update activity admission failed");
      throw err;
    }
  };
}
