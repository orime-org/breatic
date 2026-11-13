// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What collab needs to know about regions (inner#1955): whether this process
 * runs outside the global region, and the global functions it calls from
 * there. In the global region the functions run in process.
 */

import { checkSessions, createGlobalApi, env, getRedis, getRegionsConfig } from "@breatic/core";

/**
 * Whether this collab runs in a region that does not hold the sessions.
 * @returns True outside the global region.
 */
export function outsideGlobalRegion(): boolean {
  return env.REGION !== env.GLOBAL_REGION;
}

/** The global functions collab calls. */
export type CollabGlobalApi = {
  checkSessions: (sids: readonly string[]) => Promise<string[]>;
};

let api: CollabGlobalApi | null = null;

/**
 * The global functions collab calls, built on first use.
 * @returns The API: in process in the global region, signed requests elsewhere.
 */
export function collabGlobalApi(): CollabGlobalApi {
  api ??= createGlobalApi<CollabGlobalApi>(
    { checkSessions: (sids) => checkSessions(getRedis(), sids) },
    {
      region: env.REGION,
      globalRegion: env.GLOBAL_REGION,
      globalApiUrl: env.GLOBAL_API_URL,
      secret: env.INTERNAL_API_SECRET,
      timeoutMs: getRegionsConfig().global_api_timeout_ms,
    },
  );
  return api;
}
