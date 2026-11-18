// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * External agents' presence (breatic#1488 §19.2). An agent's record sits in
 * the meta document's `users` map beside its owner's, keyed
 * `{userId}.agent.{connectionId}`, so it never marks the owner online and is
 * never drawn as them. Collab writes it and web reads it.
 */
const AGENT_MARK = ".agent.";

/**
 * The `users` key of one agent connection's record.
 * @param userId - The connection's owner.
 * @param connectionId - The agent connection.
 * @returns The key.
 */
export function agentPresenceKey(userId: string, connectionId: string): string {
  return `${userId}${AGENT_MARK}${connectionId}`;
}

/**
 * The owner and connection a `users` key names, when it is an agent's.
 * @param key - A `users` key.
 * @returns Both ids, or null for a member's own key or anything else.
 */
export function parseAgentPresenceKey(key: string): { userId: string; connectionId: string } | null {
  const parts = key.split(AGENT_MARK);
  if (parts.length !== 2) return null;
  const [userId, connectionId] = parts as [string, string];
  if (userId === "" || connectionId === "" || connectionId.includes(".")) return null;
  return { userId, connectionId };
}

/**
 * One agent connection's record: the owner's id, whether it counts as
 * online, when it last acted, whether it has gone idle, and where it works:
 * its Space and the nodes or blocks it last touched (`focus`, empty until a
 * command names some).
 */
export const agentPresenceRecordSchema = z.object({
  id: z.string().min(1),
  online: z.boolean(),
  lastSeenAt: z.number(),
  idle: z.boolean().optional(),
  agent: z.object({
    connectionId: z.string().min(1),
    spaceId: z.string().min(1).nullable(),
    focus: z.array(z.string().min(1)),
    focusAt: z.number().nullable(),
  }),
});

/** One agent connection's presence record. */
export type AgentPresenceRecord = z.infer<typeof agentPresenceRecordSchema>;
