// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The running-turn leases against a real Redis (#1394).
 *
 * Each turn holds one member of a sorted set keyed by user and project, scored
 * by when it stops counting; a read drops the members whose time has passed
 * and answers the conversations of the rest. Sorted-set scores, `ZADD XX` and
 * key expiry only behave as described on a server that runs them, so these
 * cases talk to the test container rather than a double.
 *
 * The lease is shortened to 600 ms so it runs out inside a case. It is
 * deliberately not the shipped 60000, so a lease length written into the code
 * instead of read from `chat_run_lease_ms` shows up here (inner#1717).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

const { LEASE_MS } = vi.hoisted(() => ({ LEASE_MS: 600 }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...(actual.getAgentConfig as () => Record<string, unknown>)(),
      chat_run_lease_ms: LEASE_MS,
    }),
  };
});

import crypto from "node:crypto";
import { env, getRedis, initCore } from "@breatic/core";
import { holdRunning, runningConversationIds } from "@server/modules/conversation/running-turns.service.js";


beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
});

/**
 * Sleep for real time.
 * @param ms - How long.
 * @returns A promise that resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One user's view of one project, fresh for each case. */
interface Scope {
  userId: string;
  projectId: string;
}

/**
 * A user and project no other case touches.
 * @returns The scope.
 */
function freshScope(): Scope {
  return { userId: crypto.randomUUID(), projectId: crypto.randomUUID() };
}

/**
 * The Redis key a scope's leases live under.
 * @param scope - Whose and which project.
 * @returns The key.
 */
function keyOf(scope: Scope): string {
  return `${env.REDIS_KEY_PREFIX}:server:chat-running:${scope.userId}:${scope.projectId}`;
}

/**
 * Every member under a scope's key with its score, read straight off Redis.
 * @param scope - Whose and which project.
 * @returns Member and score pairs, lowest score first.
 */
async function membersOf(scope: Scope): Promise<Array<{ member: string; score: number }>> {
  const flat = await getRedis().zrange(keyOf(scope), 0, -1, "WITHSCORES");
  const out: Array<{ member: string; score: number }> = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ member: flat[i]!, score: Number(flat[i + 1]) });
  return out;
}

describe("holdRunning", () => {
  it("lists the conversation once a lease is held on it", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();

    await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });

    expect(await runningConversationIds(scope)).toEqual([conversationId]);
  });

  it("writes one member named by the conversation and the run under the user's and project's key", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await holdRunning({ ...scope, conversationId, runId });

    expect((await membersOf(scope)).map((m) => m.member)).toEqual([`${conversationId}:${runId}`]);
  });

  it("lasts chat_run_lease_ms, on the member and on the key", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();

    const before = Date.now();
    await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });
    const after = Date.now();

    const [only] = await membersOf(scope);
    expect(only!.score).toBeGreaterThanOrEqual(before + LEASE_MS);
    expect(only!.score).toBeLessThanOrEqual(after + LEASE_MS);

    const pttl = await getRedis().pttl(keyOf(scope));
    expect(pttl).toBeLessThanOrEqual(LEASE_MS);
    expect(pttl).toBeGreaterThanOrEqual(LEASE_MS - (Date.now() - before) - 5);
  });

  it("gives every run its own member, even on the same conversation", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();

    await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });
    await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });

    const members = (await membersOf(scope)).map((m) => m.member);
    expect(members).toHaveLength(2);
    expect(new Set(members).size).toBe(2);
  });
});

describe("renew", () => {
  it("moves the member's expiry a whole lease past the renewal and refreshes the key", async () => {
    const scope = freshScope();
    const lease = await holdRunning({ ...scope, conversationId: crypto.randomUUID(), runId: crypto.randomUUID() });
    const [held] = await membersOf(scope);

    await sleep(100);
    const renewedAt = Date.now();
    await lease.renew();

    const [renewed] = await membersOf(scope);
    expect(renewed!.member).toBe(held!.member);
    expect(renewed!.score).toBeGreaterThan(held!.score);
    expect(renewed!.score).toBeGreaterThanOrEqual(renewedAt + LEASE_MS);
    const pttl = await getRedis().pttl(keyOf(scope));
    expect(pttl).toBeGreaterThan(LEASE_MS - 100);
  });

  it("keeps a renewed lease listed past the point the first hold would have run out", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();
    const lease = await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });

    await sleep(LEASE_MS * 0.6);
    await lease.renew();
    await sleep(LEASE_MS * 0.6);

    expect(await runningConversationIds(scope)).toEqual([conversationId]);
  });

  it("does not bring back a lease a read already dropped", async () => {
    const scope = freshScope();
    const lease = await holdRunning({ ...scope, conversationId: crypto.randomUUID(), runId: crypto.randomUUID() });

    await sleep(LEASE_MS + 100);
    expect(await runningConversationIds(scope)).toEqual([]);

    await lease.renew();

    expect(await runningConversationIds(scope)).toEqual([]);
    expect(await membersOf(scope)).toEqual([]);
  });
});

describe("release", () => {
  it("takes the conversation off the list at once", async () => {
    const scope = freshScope();
    const lease = await holdRunning({ ...scope, conversationId: crypto.randomUUID(), runId: crypto.randomUUID() });

    await lease.release();

    expect(await runningConversationIds(scope)).toEqual([]);
    expect(await membersOf(scope)).toEqual([]);
  });

  it("removes only its own lease when a run and the next one in its conversation both hold one", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();
    const first = await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });
    const second = await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });

    await first.release();

    expect(await runningConversationIds(scope)).toEqual([conversationId]);
    expect(await membersOf(scope)).toHaveLength(1);

    await second.release();

    expect(await runningConversationIds(scope)).toEqual([]);
  });

  it("leaves the other lease's expiry alone when one is renewed", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();
    const first = await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });
    await sleep(20);
    await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });
    const before = await membersOf(scope);

    await sleep(50);
    await first.renew();

    const after = await membersOf(scope);
    const scoreOf = (list: Array<{ member: string; score: number }>, member: string): number | undefined =>
      list.find((m) => m.member === member)?.score;
    // The second hold was written last, so before the renewal it holds the
    // higher score; the renewal moves the first past it and leaves it put.
    const secondMember = before[1]!.member;
    expect(scoreOf(after, secondMember)).toBe(before[1]!.score);
    expect(scoreOf(after, before[0]!.member)).toBeGreaterThan(before[0]!.score);
  });
});

describe("runningConversationIds", () => {
  it("names each running conversation once, however many leases it has", async () => {
    const scope = freshScope();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await holdRunning({ ...scope, conversationId: a, runId: crypto.randomUUID() });
    await holdRunning({ ...scope, conversationId: a, runId: crypto.randomUUID() });
    await holdRunning({ ...scope, conversationId: b, runId: crypto.randomUUID() });

    const ids = await runningConversationIds(scope);

    expect([...ids].sort()).toEqual([a, b].sort());
  });

  it("answers nothing for a scope with no leases", async () => {
    expect(await runningConversationIds(freshScope())).toEqual([]);
  });

  it("keeps a lease listed inside its lease and drops it after, when nothing renews it", async () => {
    const scope = freshScope();
    const conversationId = crypto.randomUUID();
    await holdRunning({ ...scope, conversationId, runId: crypto.randomUUID() });

    await sleep(LEASE_MS / 2);
    expect(await runningConversationIds(scope)).toEqual([conversationId]);

    await sleep(LEASE_MS / 2 + 150);
    expect(await runningConversationIds(scope)).toEqual([]);
  });

  it("drops a lease whose time has passed while the key is kept alive by another", async () => {
    const scope = freshScope();
    const stale = crypto.randomUUID();
    const live = crypto.randomUUID();
    await holdRunning({ ...scope, conversationId: stale, runId: crypto.randomUUID() });
    await sleep(LEASE_MS * 0.6);
    // Refreshes the key's own expiry, so only the stale member's score says
    // it is over: what drops it has to be the read, not the key expiring.
    await holdRunning({ ...scope, conversationId: live, runId: crypto.randomUUID() });
    await sleep(LEASE_MS * 0.6);

    expect(await runningConversationIds(scope)).toEqual([live]);
    const left = (await membersOf(scope)).map((m) => m.member);
    expect(left).toHaveLength(1);
    expect(left[0]!.startsWith(`${live}:`)).toBe(true);
  });

  it("reads only the asking user's leases in the asked project", async () => {
    const owner = freshScope();
    await holdRunning({ ...owner, conversationId: crypto.randomUUID(), runId: crypto.randomUUID() });

    expect(await runningConversationIds({ userId: crypto.randomUUID(), projectId: owner.projectId })).toEqual([]);
    expect(await runningConversationIds({ userId: owner.userId, projectId: crypto.randomUUID() })).toEqual([]);
  });
});
