// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Why collab closed one document of a shared socket, when the answer is "come
 * straight back in".
 *
 * Hocuspocus closes a single document with a CLOSE message that carries only a
 * reason string; the client reads the code as 1000 whatever the server sent.
 * So the REASON is the contract between the two ends: collab sends one of these
 * after changing what a member may do with a project, and the web client, on
 * seeing one, re-sends its token for that document on the same socket so the
 * server can answer with the new scope. Any other reason is left as it was.
 *
 * One definition, read by both ends, because a reason spelled differently on
 * either side would silently leave that member disconnected.
 */
export const COLLAB_REAUTH_REASONS = {
  /** The project was archived: everyone comes back read-only. */
  projectArchived: "Project archived",
  /** The project was restored: everyone comes back with their own role. */
  projectRestored: "Project restored",
  /** A duplicate's documents were copied in: reload the copied content. */
  projectContentUpdated: "Project content updated",
  /** This member's role changed: come back with the new one. */
  permissionChanged: "Permission changed, please reconnect",
} as const;

const REAUTH_REASONS: ReadonlySet<string> = new Set(Object.values(COLLAB_REAUTH_REASONS));

/**
 * Whether a document's close asks the client to authenticate again at once.
 * @param reason - The reason carried by the close.
 * @returns True for one of {@link COLLAB_REAUTH_REASONS}.
 */
export function isReauthCloseReason(reason: string | undefined): boolean {
  return reason !== undefined && REAUTH_REASONS.has(reason);
}
