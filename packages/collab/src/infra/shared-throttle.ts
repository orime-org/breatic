// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The connection throttle every collab instance shares (inner#1497 §6.6).
 *
 * Counts and bans live in Redis, so an IP gets the same limit however many
 * instances its connections land on. The verdicts match the in-memory
 * `@hocuspocus/extension-throttle` this replaces: within a 60-second window a
 * limit of N allows N connections and denies from the next one on, which then
 * bans the IP for the configured minutes. The window is core's
 * `checkRateLimit`, the sliding window every other rate limit uses.
 *
 * When Redis cannot answer, the connection is let through and the error is
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
  /** Connections allowed per identity within the window. */
  maxAttempts: number;
  /** Ban length after the limit is passed, in minutes. */
  banMinutes: number;
  /** Told about a Redis error; the connection is let through. */
  onError: (err: unknown, identity: string) => void;
}

/**
 * Build the shared throttle.
 * @param deps - Redis client, limits and the error reporter.
 * @returns The throttle the connection gate calls.
 */
export function createSharedThrottle(deps: SharedThrottleDeps): Throttle {
  return async (identity: string): Promise<void> => {
    const banKey = `${env.ENV}:collab:conn-ban:${identity}`;
    let allowed: boolean;
    try {
      if (await deps.redis.get(banKey)) {
        allowed = false;
      } else {
        allowed = await checkRateLimit(deps.redis, `collab-connect:${identity}`, deps.maxAttempts, WINDOW_SECONDS);
        if (!allowed) await deps.redis.set(banKey, "1", "EX", deps.banMinutes * 60);
      }
    } catch (err) {
      deps.onError(err, identity);
      return;
    }
    // A falsy rejection, as the extension gives: hocuspocus treats it as
    // "refuse quietly".
    if (!allowed) throw undefined;
  };
}
