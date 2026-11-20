// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The DB4 set of threads newly handed to one external-agent connection
 * (breatic#1488 §15.11). Collab adds and removes members while it holds the
 * Space count lock, after the record's transaction committed; the MCP
 * service takes them for each tool result. A failed write costs one
 * reminder (`list_assignments` stays right), so it is logged, not raised.
 */

import { createLogger, env, getMcpConfig, getMcpRedis } from "@breatic/core";
import { mcpNewAssignmentsKey } from "@breatic/shared";

const logger = createLogger("new-assignments");

/**
 * The set member for one thread.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param threadId - The thread.
 * @returns `{projectId}:{spaceId}:{threadId}`.
 */
export function newAssignmentMember(projectId: string, spaceId: string, threadId: string): string {
  return `${projectId}:${spaceId}:${threadId}`;
}

/**
 * Add a thread to a connection's set and renew the set's lifetime.
 * @param connectionId - The connection.
 * @param member - The thread's member.
 */
export async function addNewAssignment(connectionId: string, member: string): Promise<void> {
  const key = mcpNewAssignmentsKey(env.REDIS_KEY_PREFIX, connectionId);
  try {
    await getMcpRedis().multi().sadd(key, member).expire(key, getMcpConfig().new_assignments_ttl_seconds).exec();
  } catch (err) {
    logger.error({ err, ctx: { connectionId, member } }, "new_assignment_add_failed");
  }
}

/**
 * Take a thread out of a connection's set.
 * @param connectionId - The connection.
 * @param member - The thread's member.
 */
export async function removeNewAssignment(connectionId: string, member: string): Promise<void> {
  try {
    await getMcpRedis().srem(mcpNewAssignmentsKey(env.REDIS_KEY_PREFIX, connectionId), member);
  } catch (err) {
    logger.error({ err, ctx: { connectionId, member } }, "new_assignment_remove_failed");
  }
}
