// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The session id index and the revocation tombstones (inner#1955) — real Redis.
 *
 * Other regions know a session only by its id (the SHA-256 of its token), so
 * the global region keeps `{ENV}:session-id:{sid}` beside every session, with
 * the same lifetime, and answers "which of these ids have ended" from it. A
 * region that hears of a revocation writes a tombstone that outlives every
 * identity token already signed for that session.
 *
 * The pins:
 *
 *   1. Creating a session writes its id index with the session's lifetime.
 *   2. Every way a session ends removes its id index.
 *   3. The backfill for sessions made before the index existed writes the
 *      index only while the session is still there, with its remaining
 *      lifetime, so a backfill that races a revocation never brings it back.
 *   4. `checkSessions` names exactly the ids whose sessions have ended.
 *   5. A tombstone marks an id revoked for 120 seconds, longer than a token.
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  backfillSessionIdIndex,
  checkSessions,
  env,
  getRedis,
  initCore,
  isIdentityRevoked,
  recordRevokedIdentities,
  revokeAllSessions,
  revokeSession,
  sessionId,
  setSession,
} from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // Already initialised by another file in this fork.
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

beforeAll(async () => {
  await getRedis().ping();
});

/**
 * A random session token.
 * @returns The token.
 */
function token(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * A random user id.
 * @returns The id.
 */
function userId(): string {
  return crypto.randomUUID();
}

/**
 * The Redis key of a session's id index.
 * @param sessionToken - The session token.
 * @returns The key.
 */
function indexKey(sessionToken: string): string {
  return `${env.ENV}:session-id:${sessionId(sessionToken)}`;
}

describe("session id index", () => {
  it("is written with the session, holding its user and its lifetime", async () => {
    const t = token();
    const user = userId();
    await setSession(getRedis(), t, user);

    expect(await getRedis().get(indexKey(t))).toBe(user);
    const ttl = await getRedis().ttl(indexKey(t));
    expect(ttl).toBeGreaterThan(THIRTY_DAYS_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(THIRTY_DAYS_SECONDS);
  });

  it("goes when one session is revoked", async () => {
    const t = token();
    await setSession(getRedis(), t, userId());
    expect(await getRedis().exists(indexKey(t))).toBe(1);

    await revokeSession(getRedis(), t);

    expect(await getRedis().exists(indexKey(t))).toBe(0);
  });

  it("goes for every ended session of a user and stays for the kept one", async () => {
    const user = userId();
    const kept = token();
    const ended = [token(), token()];
    for (const t of [kept, ...ended]) await setSession(getRedis(), t, user);
    for (const t of ended) expect(await getRedis().exists(indexKey(t))).toBe(1);

    await revokeAllSessions(getRedis(), user, { keep: kept });

    expect(await getRedis().get(indexKey(kept))).toBe(user);
    for (const t of ended) expect(await getRedis().exists(indexKey(t))).toBe(0);
  });

  it("is backfilled for a session made before the index existed, with its remaining lifetime", async () => {
    const t = token();
    const user = userId();
    await getRedis().set(`${env.ENV}:session:${t}`, user, "EX", 3600);

    await backfillSessionIdIndex(getRedis(), t);

    expect(await getRedis().get(indexKey(t))).toBe(user);
    const ttl = await getRedis().ttl(indexKey(t));
    expect(ttl).toBeGreaterThan(3595);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it("is not brought back by a backfill that runs after the session was revoked", async () => {
    const t = token();
    await setSession(getRedis(), t, userId());
    await revokeSession(getRedis(), t);

    await backfillSessionIdIndex(getRedis(), t);

    expect(await getRedis().exists(indexKey(t))).toBe(0);
  });
});

describe("checkSessions", () => {
  it("names exactly the ids whose sessions have ended", async () => {
    const user = userId();
    const live = token();
    const revoked = token();
    await setSession(getRedis(), live, user);
    await setSession(getRedis(), revoked, user);
    await revokeSession(getRedis(), revoked);
    const neverExisted = sessionId(token());

    const ended = await checkSessions(getRedis(), [sessionId(live), sessionId(revoked), neverExisted]);

    expect(new Set(ended)).toEqual(new Set([sessionId(revoked), neverExisted]));
  });

  it("answers an empty list with an empty list", async () => {
    expect(await checkSessions(getRedis(), [])).toEqual([]);
  });
});

describe("revocation tombstones", () => {
  it("mark each id revoked for 120 seconds", async () => {
    const sids = [sessionId(token()), sessionId(token())];
    await recordRevokedIdentities(getRedis(), sids);

    for (const sid of sids) {
      expect(await isIdentityRevoked(getRedis(), sid)).toBe(true);
      const ttl = await getRedis().ttl(`${env.ENV}:identity-revoked:${sid}`);
      expect(ttl).toBeGreaterThan(115);
      expect(ttl).toBeLessThanOrEqual(120);
    }
  });

  it("leave every other id unrevoked", async () => {
    expect(await isIdentityRevoked(getRedis(), sessionId(token()))).toBe(false);
  });
});
