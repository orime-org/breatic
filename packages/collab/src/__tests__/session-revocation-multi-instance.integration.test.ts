// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ended sessions close their connections on every collab instance
 * (inner#1548) — real Redis, two instances.
 *
 * The server ends sessions with core's revoke functions, which delete them and
 * publish their ids. Each instance holds some of the person's connections, so
 * each must hear the announcement and close its own. What one instance holds
 * for other sessions, or for other people, stays open.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { Hocuspocus } from "@hocuspocus/server";
import {
  initCore,
  createRedisClient,
  getRedis,
  getSession,
  setSession,
  sessionId,
  revokeAllSessions,
  revokeSession,
  type Redis,
} from "@breatic/core";
import { COLLAB_REAUTH_REASONS } from "@breatic/shared";
import { startSessionRevocation, type SessionRevocation } from "@collab/services/session-revocation.js";

try {
  initCore(process.env);
} catch {
  // Already initialised by another file in this fork.
}

interface Held {
  context: { user: { id: string; role: string }; handedOverFrom: null; session: { token: string; id: string } };
  close: (event: { code: number; reason: string }) => void;
  closedWith: { code: number; reason: string } | null;
  closedAfterMs: number | null;
}

const started: SessionRevocation[] = [];
const clients: Redis[] = [];
let publishedAt = 0;

/**
 * A connection opened with a session.
 * @param userId - Whose connection.
 * @param token - The session it was opened with.
 * @returns The connection, recording how and when it was closed.
 */
function held(userId: string, token: string): Held {
  const connection: Held = {
    context: { user: { id: userId, role: "editor" }, handedOverFrom: null, session: { token, id: sessionId(token) } },
    closedWith: null,
    closedAfterMs: null,
    close: (event) => {
      connection.closedWith = event;
      connection.closedAfterMs = Date.now() - publishedAt;
    },
  };
  return connection;
}

/**
 * Start one instance's revocation service over the given connections.
 * @param connections - What this instance holds.
 * @returns Once its subscription is confirmed.
 */
async function instance(connections: Held[]): Promise<void> {
  const hocuspocus = {
    documents: new Map([["project-p/canvas-c", { connections: new Map(connections.map((c) => [c, {}])) }]]),
  } as unknown as Hocuspocus;
  const source = createRedisClient(process.env.REDIS_STREAM_URL!, { name: "revocation-test", lazyConnect: false, commandTimeout: undefined });
  clients.push(source);
  started.push(
    await startSessionRevocation(hocuspocus, {
      source,
      readSession: (token) => getSession(getRedis(), token),
      recheckIntervalMs: 3_600_000,
    }),
  );
}

/**
 * Mint a real session.
 * @param userId - Whose.
 * @returns The token.
 */
async function session(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return token;
}

/**
 * Wait until a condition holds.
 * @param check - The condition.
 * @param ms - How long to wait.
 * @returns Once it holds.
 * @throws {Error} When it does not within the time.
 */
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ENDED = { code: 4401, reason: COLLAB_REAUTH_REASONS.sessionEnded };

let alice: string;
let bob: string;
let kept: string;
let endedA: string;
let endedB: string;
let bobs: string;
let onA: Held[];
let onB: Held[];

beforeAll(async () => {
  alice = crypto.randomUUID();
  bob = crypto.randomUUID();
  [kept, endedA, endedB, bobs] = [await session(alice), await session(alice), await session(alice), await session(bob)];
  onA = [held(alice, endedA), held(alice, kept), held(bob, bobs)];
  onB = [held(alice, endedB), held(alice, kept)];
  await instance(onA);
  await instance(onB);
});

afterAll(async () => {
  for (const revocation of started) await revocation.stop();
  for (const client of clients) await client.quit();
});

describe("ending sessions across two collab instances", () => {
  it("closes the ended sessions' connections on both instances within a second, and nothing else", async () => {
    publishedAt = Date.now();
    const outcome = await revokeAllSessions(getRedis(), alice, { keep: kept });
    expect(outcome.signalFailure).toBeUndefined();

    await until(() => onA[0]!.closedWith !== null && onB[0]!.closedWith !== null, 1_000);

    expect(onA[0]!.closedWith).toEqual(ENDED);
    expect(onB[0]!.closedWith).toEqual(ENDED);
    expect(onA[0]!.closedAfterMs).toBeLessThan(1_000);
    expect(onB[0]!.closedAfterMs).toBeLessThan(1_000);
    // The kept session and the other person stay connected.
    expect(onA[1]!.closedWith).toBeNull();
    expect(onB[1]!.closedWith).toBeNull();
    expect(onA[2]!.closedWith).toBeNull();
    // What the reconnecting handshake reads: the ended sessions are gone.
    expect(await getSession(getRedis(), endedA)).toBeNull();
    expect(await getSession(getRedis(), endedB)).toBeNull();
    expect(await getSession(getRedis(), kept)).toBe(alice);
  });

  it("signing out closes that one session everywhere", async () => {
    publishedAt = Date.now();
    await revokeSession(getRedis(), kept);
    await until(() => onA[1]!.closedWith !== null && onB[1]!.closedWith !== null, 1_000);
    expect(onA[1]!.closedWith).toEqual(ENDED);
    expect(onB[1]!.closedWith).toEqual(ENDED);
    expect(onA[2]!.closedWith).toBeNull();
  });
});
