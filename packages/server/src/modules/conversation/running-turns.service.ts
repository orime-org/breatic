// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which of a user's conversations have an Agent turn running (#1394).
 *
 * A run goes on in the background on whichever server instance opened it, so
 * other tabs and devices of the same user can only learn of it from Redis.
 * Each run holds one member of a sorted set keyed by user and project, named
 * `conversation id:run id` and scored by the moment it stops counting; the run
 * holds it from its opening stage, renews it with its hold on the conversation
 * and removes it once settled, whoever is reading (inner#1717). A process that
 * dies stops renewing, and its member runs out within one lease.
 *
 * The lease is `chat_run_lease_ms`, the same span a run holds its
 * conversation for.
 */

import { env, getAgentConfig, getRedis } from "@breatic/core";

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
  return getAgentConfig().chat_run_lease_ms;
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
 * @param scope.runId - The run that holds it.
 * @returns The lease, to renew with the run's hold and release once it is settled.
 * @throws {Error} When Redis refuses or cannot be reached.
 */
export async function holdRunning(scope: RunningScope & { conversationId: string; runId: string }): Promise<RunningLease> {
  const key = keyOf(scope);
  // One member per run: a run that goes straight on to the next holds the
  // next one's before letting its own go, and neither takes the other's away.
  const member = `${scope.conversationId}:${scope.runId}`;
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
