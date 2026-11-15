// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A paste names assets by storage key, and the asset may be registered in
 * another region (inner#1955, design 6.15): the bytes sit in the one shared
 * bucket, so the row found there is registered here without copying them.
 */

import { callRegion, env, getRegionsConfig, isGlobalRegion, logger, otherRegionsOf } from "@breatic/core";
import { globalApi } from "@breatic/domain";
import type { StudioAssetEntity } from "@breatic/shared";

/** The lookups another region answers by storage key. */
export type KeyLookup = "findAssetByKey" | "findCoverUnderKey";

/**
 * Ask the other regions for a row this region does not hold: the global
 * region asks every other region, any other region asks the global region.
 * A region that does not answer in time counts as holding nothing.
 * @param lookup - Which row to ask for.
 * @param storageKey - The key.
 * @returns The first row found, or null.
 */
export async function findElsewhereByKey(lookup: KeyLookup, storageKey: string): Promise<StudioAssetEntity | null> {
  if (!isGlobalRegion(env)) {
    try {
      return await globalApi()[lookup](storageKey);
    } catch (err) {
      logger.error({ err, ctx: { lookup, region: env.GLOBAL_REGION, storageKey } }, "asset_lookup_elsewhere_failed");
      return null;
    }
  }
  for (const region of otherRegionsOf(env)) {
    try {
      const row = (await callRegion(region, lookup, [storageKey], getRegionsConfig().cross_region_fanout_timeout_ms)) as StudioAssetEntity | null;
      if (row !== null) return row;
    } catch (err) {
      logger.error({ err, ctx: { lookup, region, storageKey } }, "asset_lookup_elsewhere_failed");
    }
  }
  return null;
}
