// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether an external agent shown in a project may still be shown
 * (breatic#1488 §19.2): its connection can still be used and its owner is
 * still a member. Announcements end an agent at once; these checks catch
 * what an announcement could not reach: a meta document loaded on no
 * instance when the credential was revoked, or a listener that was down.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type * as Y from "yjs";
import { parseDocName, projectMetaDocName } from "@breatic/shared";
import { listAgentPresence, markAgentsOffline } from "@collab/hooks/presence.js";
import type { LoadRole } from "@collab/services/role-recheck.js";

/** The two facts an agent's presence rests on. */
export interface AgentPresenceChecks {
  /** Whether the agent's connection can still be used. */
  isConnectionUsable: (connectionId: string) => Promise<boolean>;
  /** The owner's role on the project, null once they are not a member. */
  loadRole: LoadRole;
}

/**
 * Mark offline every online agent in one meta document whose connection can
 * no longer be used or whose owner is no longer a member. Nothing changes
 * when a check fails.
 * @param meta - The project's meta document.
 * @param projectId - The project.
 * @param checks - Connection and membership lookups.
 * @throws {Error} When a lookup fails.
 */
export async function recheckAgentsInMeta(meta: Y.Doc, projectId: string, checks: AgentPresenceChecks): Promise<void> {
  const agents = listAgentPresence(meta).filter((a) => a.online);
  if (agents.length === 0) return;
  const owners = [...new Set(agents.map((a) => a.userId))];
  const [usable, members] = await Promise.all([
    Promise.all(agents.map(async (a) => [a.connectionId, await checks.isConnectionUsable(a.connectionId)] as const)),
    Promise.all(owners.map(async (userId) => [userId, (await checks.loadRole(userId, projectId)) !== null] as const)),
  ]);
  const usableIds = new Set(usable.filter(([, ok]) => ok).map(([id]) => id));
  const memberIds = new Set(members.filter(([, ok]) => ok).map(([id]) => id));
  markAgentsOffline({ document: meta, matches: (a) => !usableIds.has(a.connectionId) || !memberIds.has(a.userId) });
}

/**
 * Mark offline one owner's agents in a project, once they have left it.
 * @param hocuspocus - The server.
 * @param projectId - The project.
 * @param userId - The former member.
 */
export function endOwnerAgents(hocuspocus: Hocuspocus, projectId: string, userId: string): void {
  const meta = hocuspocus.documents?.get(projectMetaDocName(projectId));
  if (meta) markAgentsOffline({ document: meta, matches: (a) => a.userId === userId });
}

/**
 * Recheck the agents in every meta document loaded on this instance.
 * @param hocuspocus - The server.
 * @param checks - Connection and membership lookups.
 * @throws {Error} When a lookup fails; documents already checked keep their changes.
 */
export async function recheckLoadedAgents(hocuspocus: Hocuspocus, checks: AgentPresenceChecks): Promise<void> {
  const metas: Array<[Y.Doc, string]> = [];
  for (const [name, doc] of hocuspocus.documents ?? []) {
    const parsed = parseDocName(name);
    if (parsed?.kind === "meta") metas.push([doc, parsed.projectId]);
  }
  await Promise.all(metas.map(([doc, projectId]) => recheckAgentsInMeta(doc, projectId, checks)));
}
