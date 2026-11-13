// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global functions core itself calls (inner#1955): in the global region
 * they run in process; elsewhere each is a signed call to the global region,
 * which serves the same implementation under the same name.
 */

import { enqueueAccountAdsConversion } from "@core/ads/ads-conversion.js";
import { env } from "@core/config/env.js";
import { getRegionsConfig } from "@core/config/regions.js";
import { createGlobalApi } from "@core/region/global-api.js";

/** The global functions core calls. */
export type CoreGlobalApi = {
  enqueueAdsConversion: typeof enqueueAccountAdsConversion;
};

let api: CoreGlobalApi | null = null;

/**
 * The global functions core calls, built on first use.
 * @returns In process in the global region, signed requests elsewhere.
 */
export function coreGlobalApi(): CoreGlobalApi {
  api ??= createGlobalApi<CoreGlobalApi>(
    { enqueueAdsConversion: enqueueAccountAdsConversion },
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
