// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Applying `project_members` changes to this instance's open connections
 * (inner#911).
 *
 * A connection is authorized once, at its handshake, from `project_members`.
 * The trigger on that table announces every committed change (core
 * `listenProjectMemberChanges`); on each one this instance closes the named
 * person's connections on the named project, and the web client
 * re-authenticates against the row as it now stands.
 *
 * A change committed while nobody is listening is not delivered. Listening
 * restarts after the listen connection drops, so every time it (re)starts each
 * registered connection is checked against its current role.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import {
  createLogger,
  type MemberChangeHandlers,
  type MemberChangeListener,
} from "@breatic/core";
import { COLLAB_REAUTH_REASONS } from "@breatic/shared";
import { forEachProjectConnection } from "@collab/services/project-connections.js";
import { recheckRoleOnConnect, type LoadRole } from "@collab/services/role-recheck.js";
import type { AuthContext } from "@collab/hooks/auth.js";

const logger = createLogger("member-change-sync");

/** What {@link startMemberChangeSync} needs from outside. */
export interface MemberChangeSyncDeps {
  /** Starts the listener (core `listenProjectMemberChanges`). */
  listen: (handlers: MemberChangeHandlers) => Promise<MemberChangeListener>;
  /** The current-role reader (core `projectAuthService.loadProjectRole`). */
  loadRole: LoadRole;
}

/**
 * Close every connection a person holds on any document of a project on this
 * instance, with the reason the web client re-authenticates on.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param projectId - The project.
 * @param userId - The person.
 */
export function kickUserFromProject(
  hocuspocus: Hocuspocus,
  projectId: string,
  userId: string,
): void {
  forEachProjectConnection(hocuspocus, projectId, (connection) => {
    const ctx = connection.context as AuthContext | undefined;
    if (ctx?.user?.id === userId) {
      connection.close({ code: 4403, reason: COLLAB_REAUTH_REASONS.permissionChanged });
    }
  });
}

/**
 * Check every registered connection on this instance against its holder's
 * current role, closing the ones that changed. A failed read is logged and the
 * rest are still checked.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param loadRole - The current-role reader.
 * @returns Once every connection has been checked.
 */
export async function recheckAllConnections(
  hocuspocus: Hocuspocus,
  loadRole: LoadRole,
): Promise<void> {
  const checks: Array<Promise<void>> = [];
  for (const [documentName, doc] of hocuspocus.documents?.entries() ?? []) {
    for (const [connection] of doc.connections) {
      const user = (connection.context as AuthContext | undefined)?.user;
      if (!user) continue;
      checks.push(
        recheckRoleOnConnect(
          { documentName, userId: user.id, grantedRole: user.role, connection },
          loadRole,
        ).catch((err: unknown) => {
          logger.error({ err, documentName, userId: user.id }, "member_change_recheck_failed");
        }),
      );
    }
  }
  await Promise.all(checks);
}

/**
 * Start applying membership changes to this instance's connections.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param deps - The listener and the current-role reader.
 * @returns The running listener; stop it on shutdown.
 * @throws {Error} When the first LISTEN fails.
 */
export async function startMemberChangeSync(
  hocuspocus: Hocuspocus,
  deps: MemberChangeSyncDeps,
): Promise<MemberChangeListener> {
  return deps.listen({
    onChange: ({ projectId, userId }) => {
      kickUserFromProject(hocuspocus, projectId, userId);
      logger.info({ projectId, userId }, "member_change_applied");
    },
    onListening: () => {
      logger.info("member_change_listening");
      void recheckAllConnections(hocuspocus, deps.loadRole);
    },
    onInvalid: (raw) => {
      logger.error({ raw }, "member_change_payload_invalid");
    },
  });
}
