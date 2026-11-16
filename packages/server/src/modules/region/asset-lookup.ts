// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A paste names assets by storage key, and the asset may be registered in
 * another region (inner#1955, design 6.15): the bytes sit in the one shared
 * bucket, so the row found there is registered here without copying them.
 */

import { callRegion, env, getRegionsConfig, isGlobalRegion, logger, otherRegionsOf } from "@breatic/core";
import { globalApi, type KeyLookupAnswer } from "@breatic/domain";

/**
 * Ask the other regions, in one call each and all at once, what they hold
 * under keys this region's ledger does not: the global region asks every
 * other region, any other region asks the global region. A region that does
 * not answer in time counts as holding nothing.
 * @param keys - The keys.
 * @returns Each key's live row and cover row, first found across the regions.
 */
export async function findElsewhereByKeys(keys: readonly string[]): Promise<Map<string, KeyLookupAnswer>> {
  const found = new Map<string, KeyLookupAnswer>();
  if (keys.length === 0) return found;
  const asked = isGlobalRegion(env)
    ? otherRegionsOf(env).map((region) => ({
      region,
      answer: callRegion(region, "findAssetsByKeys", [keys], getRegionsConfig().cross_region_fanout_timeout_ms) as Promise<Record<string, KeyLookupAnswer>>,
    }))
    : [{ region: env.GLOBAL_REGION, answer: globalApi().findAssetsByKeys([...keys]) }];
  const nothing: Record<string, KeyLookupAnswer> = {};
  const answers = await Promise.all(
    asked.map(({ region, answer }) =>
      answer.catch((err: unknown) => {
        logger.error({ err, ctx: { region, keys: keys.length } }, "asset_lookup_elsewhere_failed");
        return nothing;
      }),
    ),
  );
  for (const key of keys) {
    // A region that answered nothing usable counts as holding nothing.
    const each = answers.map((answer: Record<string, KeyLookupAnswer> | null) => answer?.[key]);
    found.set(key, {
      asset: each.find((answer) => answer !== undefined && answer.asset !== null)?.asset ?? null,
      cover: each.find((answer) => answer !== undefined && answer.cover !== null)?.cover ?? null,
    });
  }
  return found;
}
