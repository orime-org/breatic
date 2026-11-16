// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The global functions core itself calls (inner#1955): in the global region
 * they run in process; elsewhere each is a signed call to the global region,
 * which serves the same implementation under the same name.
 */

import { enqueueAccountAdsConversion } from "@core/ads/ads-conversion.js";
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
  api ??= createGlobalApi<CoreGlobalApi>({ enqueueAdsConversion: enqueueAccountAdsConversion });
  return api;
}
