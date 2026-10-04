// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Re-read a connection's project role once the connection is registered.
 *
 * The handshake reads the role, then loads the document, and only then is the
 * connection added to the document — the only place a kick (archive, restore,
 * a role change) can find it. A handshake that read the role just before such
 * a change committed, and registered after the kick ran, keeps a scope that no
 * longer holds and is never told. Reading again after registering leaves no
 * gap: the kick reaches the connection, or this read sees the new role. On a
 * difference the connection is closed with the reason the web client
 * re-authenticates on, so it comes straight back with the right scope.
 */

import { COLLAB_REAUTH_REASONS, parseDocName, type ProjectRole } from "@breatic/shared";

/** The connection as this check needs it. */
interface ClosableConnection {
  close: (event: { code: number; reason: string }) => void;
}

/** One registered connection and the role its handshake granted. */
export interface RegisteredConnection {
  documentName: string;
  userId: string;
  grantedRole: ProjectRole;
  connection: ClosableConnection;
}

/**
 * Close the connection when the caller's role differs from the one granted.
 * @param registered - The connection, its document and the granted role.
 * @param loadRole - Reads the caller's current role, archive cap included.
 * @returns Once the check has run.
 * @throws {Error} Whatever `loadRole` throws; the caller logs it.
 */
export async function recheckRoleOnConnect(
  registered: RegisteredConnection,
  loadRole: (userId: string, projectId: string) => Promise<ProjectRole | null>,
): Promise<void> {
  const parsed = parseDocName(registered.documentName);
  if (!parsed) return;
  const now = await loadRole(registered.userId, parsed.projectId);
  if (now === registered.grantedRole) return;
  registered.connection.close({ code: 4403, reason: COLLAB_REAUTH_REASONS.permissionChanged });
}
