// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which of a user's conversations have an Agent turn running (#1394).
 *
 * A turn runs inside one SSE request on whichever server instance took it, so
 * other tabs and devices of the same user can only learn of it from Redis.
 * Each running turn holds one member of a sorted set keyed by user and
 * project, scored by the moment it stops counting; the turn renews it on every
 * heartbeat and removes it when it ends. A process that dies stops renewing,
 * and its member runs out within one lease.
 *
 * The lease is the heartbeat interval times the beats a browser lets go
 * missing: the same span after which a browser declares the stream gone.
 */

import { randomUUID } from "node:crypto";
import { env, getAgentConfig, getRedis } from "@breatic/core";
import { SSE_HEARTBEAT_MISSES_ALLOWED } from "@breatic/shared";

/** One running turn's hold on its conversation's place in the set. */
export interface RunningLease {
  /** Push the lease's end one lease length past now. */
  renew(): Promise<void>;
  /** Take the turn out of the set. */
  release(): Promise<void>;
}

/** Whose conversations, and in which project. */
interface RunningScope {
  userId: string;
  projectId: string;
}

/**
 * How long a lease counts without a renewal.
 * @returns The span in milliseconds.
 * @throws {never} Never.
 */
function leaseMs(): number {
  return getAgentConfig().sse_heartbeat_interval_ms * SSE_HEARTBEAT_MISSES_ALLOWED;
}

/**
 * The key one user's leases in one project live under.
 * @param scope - Whose and which project.
 * @returns The Redis key.
 * @throws {never} Never.
 */
function keyOf(scope: RunningScope): string {
  return `${env.REDIS_KEY_PREFIX}:server:chat-running:${scope.userId}:${scope.projectId}`;
}

/**
 * Write a member's end time and keep the key alive as long as the newest lease.
 * @param key - The set.
 * @param member - The lease's member.
 * @param onlyExisting - Renewing: leave a member that is already gone gone.
 * @returns When both writes are done.
 * @throws {Error} When Redis refuses or cannot be reached.
 */
async function writeLease(key: string, member: string, onlyExisting: boolean): Promise<void> {
  const ms = leaseMs();
  const until = Date.now() + ms;
  const tx = getRedis().multi();
  if (onlyExisting) tx.zadd(key, "XX", until, member);
  else tx.zadd(key, until, member);
  tx.pexpire(key, ms);
  await tx.exec();
}

/**
 * Mark a conversation as having a turn running.
 * @param scope - Whose conversation, in which project, and which one.
 * @param scope.userId - The user the turn belongs to.
 * @param scope.projectId - The project the conversation is in.
 * @param scope.conversationId - The conversation.
 * @returns The lease, to renew on every heartbeat and release when the turn ends.
 * @throws {Error} When Redis refuses or cannot be reached.
 */
export async function holdRunning(scope: {
  userId: string;
  projectId: string;
  conversationId: string;
}): Promise<RunningLease> {
  const key = keyOf(scope);
  // One member per turn: two tabs running the same conversation hold two, and
  // the first to finish does not take the other's mark away.
  const member = `${scope.conversationId}:${randomUUID()}`;
  await writeLease(key, member, false);
  return {
    renew: () => writeLease(key, member, true),
    release: async () => {
      await getRedis().zrem(key, member);
    },
  };
}

/**
 * The caller's conversations in a project with a turn running now.
 * @param scope - Whose and which project.
 * @param scope.userId - The signed-in user; only their own leases are read.
 * @param scope.projectId - The project.
 * @returns Each conversation once, in no particular order.
 * @throws {Error} When Redis refuses or cannot be reached.
 */
export async function runningConversationIds(scope: RunningScope): Promise<string[]> {
  const key = keyOf(scope);
  const now = Date.now();
  const redis = getRedis();
  await redis.zremrangebyscore(key, "-inf", now);
  const members = await redis.zrangebyscore(key, now, "+inf");
  return [...new Set(members.map((member) => member.slice(0, member.lastIndexOf(":"))))];
}
