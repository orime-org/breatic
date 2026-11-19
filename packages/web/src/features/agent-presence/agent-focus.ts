// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import type { ProjectAgent } from '@web/data/yjs/project-meta';

/** What a Space reads to draw where external agents work. */
export interface AgentPresenceValue {
  agents: ReadonlyArray<ProjectAgent>;
  /** "connection · owner" by connection id. */
  labels: ReadonlyMap<string, string>;
}

const NONE: AgentPresenceValue = { agents: [], labels: new Map() };

/** The project's external agents and their names, provided by the project page. */
export const AgentPresenceContext = React.createContext<AgentPresenceValue>(NONE);

const AGENT_PREFIX = 'agent:';

/**
 * The occupant id an agent takes beside members' user ids on the items it holds.
 * @param connectionId - The agent's connection.
 * @returns Its occupant id.
 */
export function agentOccupantId(connectionId: string): string {
  return `${AGENT_PREFIX}${connectionId}`;
}

/**
 * The connection an occupant id names, when it is an agent's.
 * @param occupantId - An occupant id.
 * @returns The connection, or null for a member.
 */
export function connectionOfOccupant(occupantId: string): string | null {
  return occupantId.startsWith(AGENT_PREFIX) ? occupantId.slice(AGENT_PREFIX.length) : null;
}

/**
 * Which agents work on which items of one Space (#1488 design 19.2): only
 * online agents that are not idle, in this Space, on the items they last named.
 * @param agents - The project's agents.
 * @param spaceId - The Space.
 * @returns Item id to the connections working on it.
 */
export function agentFocusIn(agents: ReadonlyArray<ProjectAgent>, spaceId: string): Map<string, string[]> {
  const byItem = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.online || agent.idle || agent.spaceId !== spaceId) continue;
    for (const item of agent.focus) {
      const list = byItem.get(item);
      if (list === undefined) byItem.set(item, [agent.connectionId]);
      else if (!list.includes(agent.connectionId)) list.push(agent.connectionId);
    }
  }
  return byItem;
}

/**
 * Add agents to a members' occupant table, after the members on each item.
 * @param members - Item id to the user ids holding it.
 * @param agents - Item id to the connections working on it.
 * @returns The merged table; the members' own when no agent works here, so it keeps its identity.
 */
export function withAgentOccupants(
  members: ReadonlyMap<string, readonly string[]>,
  agents: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  if (agents.size === 0) return members;
  const merged = new Map(members);
  for (const [item, connections] of agents) {
    merged.set(item, [...(members.get(item) ?? []), ...connections.map(agentOccupantId)]);
  }
  return merged;
}
