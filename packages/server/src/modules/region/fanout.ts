// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global region's reads that gather one user's data from every other
 * region the user has members or notifications in (inner#1955). Each region
 * answers within `cross_region_fanout_timeout_ms` or is reported unavailable.
 */

import {
  AppError,
  callRegion,
  env,
  getRegionsConfig,
  GlobalApiError,
  isRegionUnavailable,
  logger,
  NotFoundError,
  studioDirectoryRepo,
} from "@breatic/core";
import { t } from "@breatic/shared";

/** The `error.reason` of a call another region did not answer. */
export const REGION_UNAVAILABLE_REASON = "region_unavailable";

/**
 * Ask one other region for a function, within the fan-out wait.
 * @param region - The region.
 * @param fn - The region function.
 * @param args - Its arguments.
 * @param unavailableMessage - What to tell the user when the region does not answer.
 * @returns The region's answer.
 * @throws {NotFoundError} When the region answers that the thing asked for does not exist.
 * @throws {GlobalApiError} Any other refusal, a bug of ours the error handler logs.
 * @throws {AppError} `503` `region_unavailable` when the region is unavailable.
 */
export async function askRegion<T>(region: string, fn: string, args: unknown[], unavailableMessage: string): Promise<T> {
  try {
    return (await callRegion(region, fn, args, getRegionsConfig().cross_region_fanout_timeout_ms)) as T;
  } catch (err) {
    if (err instanceof GlobalApiError && !isRegionUnavailable(err)) {
      throw err.status === 404 ? new NotFoundError(t("server.error.not_found")) : err;
    }
    logger.error({ err, ctx: { region, fn } }, "cross_region_call_failed");
    throw new AppError(503, unavailableMessage, REGION_UNAVAILABLE_REASON);
  }
}

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
      try {
        const result = (await callRegion(region, fn, args, timeoutMs)) as T;
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
