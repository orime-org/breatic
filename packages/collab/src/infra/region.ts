// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What collab needs to know about regions (inner#1955): whether this process
 * runs outside the global region, and the global functions it calls from
 * there. In the global region the functions run in process.
 */

import {
  checkSessions,
  createGlobalApi,
  env,
  getLimitsForStudio,
  getProjectConcurrentEditorLimit,
  getRedis,
  getRegionsConfig,
  projectsRepo,
  type MembershipLimits,
} from "@breatic/core";

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
  getLimitsForStudio: (studioId: string) => Promise<MembershipLimits>;
};

let api: CollabGlobalApi | null = null;

/**
 * The global functions collab calls, built on first use.
 * @returns The API: in process in the global region, signed requests elsewhere.
 */
export function collabGlobalApi(): CollabGlobalApi {
  api ??= createGlobalApi<CollabGlobalApi>({
    checkSessions: (sids) => checkSessions(getRedis(), sids),
    getLimitsForStudio: (studioId) => getLimitsForStudio(studioId),
  });
  return api;
}

/**
 * How many writable connections one document of a project may hold at once.
 * Outside the global region the project's Studio is read here and its
 * ceilings come from the global region, cached in Redis for
 * `limits_cache_ttl_ms`; a tier change reaches an open handshake within that
 * window.
 * @param projectId - The project whose documents the ceiling applies to.
 * @returns The ceiling.
 * @throws {Error} When no live project has that id, or the global region does not answer.
 */
export async function concurrentEditorLimit(projectId: string): Promise<number> {
  if (!outsideGlobalRegion()) return getProjectConcurrentEditorLimit(projectId);
  const studioId = await projectsRepo.findOwnerStudioId(projectId);
  if (studioId === undefined) throw new Error(`No live project ${projectId}`);
  const redis = getRedis();
  const key = `${env.ENV}:studio-editor-limit:${studioId}`;
  const cached = await redis.get(key);
  if (cached !== null) return Number(cached);
  const { concurrent_editors: limit } = await collabGlobalApi().getLimitsForStudio(studioId);
  await redis.set(key, String(limit), "PX", getRegionsConfig().limits_cache_ttl_ms);
  return limit;
}
