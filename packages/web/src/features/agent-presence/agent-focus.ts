// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import type { ProjectAgent } from '@web/data/yjs/project-meta';
import { userPaletteColor } from '@web/lib/user-color';

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

/**
 * An agent's identity colour: the colour of the id it is followed by, so the
 * follow bar, its tags and its frames agree.
 * @param connectionId - The agent's connection.
 * @returns A CSS colour.
 */
export function agentColor(connectionId: string): string {
  return userPaletteColor(agentOccupantId(connectionId));
}

/**
 * The agent a follow target names (#1488 design 19.3).
 * @param agents - The project's agents.
 * @param followId - Whom this user follows: a member's id, an agent's occupant id, or null.
 * @returns The agent, or null for a member or nobody.
 */
export function followedAgent(agents: ReadonlyArray<ProjectAgent>, followId: string | null): ProjectAgent | null {
  const connectionId = followId === null ? null : connectionOfOccupant(followId);
  return agents.find((a) => a.connectionId === connectionId) ?? null;
}

/**
 * Who can be followed and by what name, members and agents together (#1488
 * design 19.3): an agent counts as online while online or idle, under its
 * occupant id and its "connection · owner" label.
 * @param online - The members online now.
 * @param names - Member names by user id.
 * @param agents - The project's agents.
 * @param labels - Agent labels by connection id.
 * @returns The online ids and the names, agents included.
 */
export function withFollowableAgents(
  online: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
  agents: ReadonlyArray<ProjectAgent>,
  labels: ReadonlyMap<string, string>,
): { online: ReadonlySet<string>; names: ReadonlyMap<string, string> } {
  const allOnline = new Set(online);
  const allNames = new Map(names);
  for (const agent of agents) {
    const id = agentOccupantId(agent.connectionId);
    if (agent.online) allOnline.add(id);
    allNames.set(id, labels.get(agent.connectionId) ?? '');
  }
  return { online: allOnline, names: allNames };
}
