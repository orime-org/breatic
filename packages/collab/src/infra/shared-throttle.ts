// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The connection throttle every collab instance shares (inner#1497 §6.6).
 *
 * Attempts are counted per client address — an IPv4 address or an IPv6 /64,
 * as core's `decideClientIdentity` names it. An attempt is a new WebSocket, or
 * a WebSocket whose authentication failed (see `infra/connection-gate.ts`).
 * Counts and bans live in Redis, so an address gets the same limit however
 * many instances its connections land on. Within a 60-second window a limit
 * of N allows N attempts and denies from the next one on, which then bans the
 * address for the configured minutes. The window is core's `checkRateLimit`,
 * the sliding window every other rate limit uses.
 *
 * Two questions, two functions: `count` records an attempt and answers whether
 * it is allowed; `isBanned` only reads the ban, for the per-document check
 * that must not count anything.
 *
 * When Redis cannot answer, the attempt is let through and the error is
 * reported: the seat registry makes the same choice, and an outage is an
 * operations event the error log carries.
 */

import { checkRateLimit, env, type Redis } from "@breatic/core";
import type { Throttle } from "@collab/infra/connection-gate.js";

/** The window the limit counts over. */
const WINDOW_SECONDS = 60;

/** What the shared throttle needs. */
export interface SharedThrottleDeps {
  /** Redis client of the rate-limit database (DB0). */
  redis: Redis;
  /** Attempts allowed per identity within the window. */
  maxAttempts: number;
  /** Ban length after the limit is passed, in minutes. */
  banMinutes: number;
  /** Told about a Redis error; the attempt is let through. */
  onError: (err: unknown, identity: string) => void;
}

/**
 * Build the shared throttle.
 * @param deps - Redis client, limits and the error reporter.
 * @returns The throttle the connection gate calls.
 */
export function createSharedThrottle(deps: SharedThrottleDeps): Throttle {
  /**
   * The ban key of one address, shared by every instance.
   * @param identity - The address.
   * @returns The Redis key.
   */
  const banKey = (identity: string): string => `${env.ENV}:collab:conn-ban:${identity}`;
  return {
    count: async (identity: string): Promise<boolean> => {
      try {
        if (await deps.redis.get(banKey(identity))) return false;
        const verdict = await checkRateLimit(deps.redis, [
          { key: `collab-connect:${identity}`, max: deps.maxAttempts, windowSeconds: WINDOW_SECONDS },
        ]);
        if (!verdict.allowed) {
          await deps.redis.set(banKey(identity), "1", "EX", deps.banMinutes * 60);
        }
        return verdict.allowed;
      } catch (err) {
        deps.onError(err, identity);
        return true;
      }
    },
    isBanned: async (identity: string): Promise<boolean> => {
      try {
        return Boolean(await deps.redis.get(banKey(identity)));
      } catch (err) {
        deps.onError(err, identity);
        return false;
      }
    },
  };
}
