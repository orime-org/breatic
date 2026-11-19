// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectAgent } from '@web/data/yjs/project-meta';

/**
 * Where an external agent stands for members (#1488 design 19.2): working on
 * the things it last named, online with nothing named yet, idle after a quiet
 * spell, or offline.
 */
export type AgentStatus = 'working' | 'online' | 'idle' | 'offline';

/** One agent as the member list shows it. */
export interface AgentRow {
  connectionId: string;
  label: string;
  status: AgentStatus;
}

const ORDER: Record<AgentStatus, number> = { working: 0, online: 1, idle: 2, offline: 3 };

/**
 * An agent's status.
 * @param agent - Its presence.
 * @returns Its status.
 */
export function agentStatus(agent: ProjectAgent): AgentStatus {
  if (!agent.online) return 'offline';
  if (agent.idle) return 'idle';
  return agent.focus.length > 0 ? 'working' : 'online';
}

/**
 * The member list's agent rows, the active ones first.
 * @param agents - The agents present in the project.
 * @param labels - Label by connection id.
 * @returns The rows.
 */
export function agentRows(agents: ReadonlyArray<ProjectAgent>, labels: ReadonlyMap<string, string>): AgentRow[] {
  return agents
    .map((a) => ({ connectionId: a.connectionId, label: labels.get(a.connectionId) ?? '', status: agentStatus(a) }))
    .sort((x, y) => ORDER[x.status] - ORDER[y.status]);
}
