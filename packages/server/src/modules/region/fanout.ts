// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global region's reads that gather one user's data from every other
 * region the user has members or notifications in (inner#1955). Each region
 * answers within `cross_region_fanout_timeout_ms` or is reported unavailable.
 */

import { callRegion, env, getRegionsConfig, logger, studioDirectoryRepo } from "@breatic/core";

/** What the other regions answered, and which did not. */
export interface RegionAnswers<T> {
  answers: { region: string; result: T }[];
  unavailableRegions: string[];
}

/**
 * Ask every other region the user is recorded in for the same function.
 * @param userId - The user.
 * @param fn - The region function.
 * @param args - Its arguments.
 * @returns The answers that came back in time, and the regions that did not answer.
 */
export async function askUserRegions<T>(userId: string, fn: string, args: unknown[]): Promise<RegionAnswers<T>> {
  const regions = (await studioDirectoryRepo.listUserRegions(userId)).filter((region) => region !== env.REGION);
  if (regions.length === 0) return { answers: [], unavailableRegions: [] };
  const timeoutMs = getRegionsConfig().cross_region_fanout_timeout_ms;
  const settled = await Promise.all(
    regions.map(async (region) => {
      const url = env.REGION_API_URLS[region];
      try {
        if (url === undefined) throw new Error(`no address for region ${region}`);
        const result = (await callRegion(fn, args, { callerRegion: env.REGION, url, secret: env.INTERNAL_API_SECRET, timeoutMs })) as T;
        return { region, answered: true as const, result };
      } catch (err) {
        logger.error({ err, ctx: { userId, region, fn } }, "cross_region_read_failed");
        return { region, answered: false as const };
      }
    }),
  );
  return {
    answers: settled.flatMap((entry) => (entry.answered ? [{ region: entry.region, result: entry.result }] : [])),
    unavailableRegions: settled.flatMap((entry) => (entry.answered ? [] : [entry.region])),
  };
}
