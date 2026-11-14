// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether a server of a deployment with more than one region would start
 * without the internal listener that the calls between regions arrive on
 * (inner#1955): the global region serves `/internal/global`, every other
 * region `/internal/region`.
 * @param config - The deployment's region settings.
 * @param config.REGION - This region.
 * @param config.GLOBAL_REGION - The region that holds the global data.
 * @param config.REGION_API_URLS - The other regions' internal addresses.
 * @param config.INTERNAL_API_ENABLED - Whether the internal listener runs.
 * @returns True when the listener is needed and off.
 */
export function lacksRegionListener(config: {
  REGION: string;
  GLOBAL_REGION: string;
  REGION_API_URLS: Record<string, string>;
  INTERNAL_API_ENABLED: boolean;
}): boolean {
  const multiRegion =
    config.REGION !== config.GLOBAL_REGION || Object.keys(config.REGION_API_URLS).some((region) => region !== config.REGION);
  return multiRegion && !config.INTERNAL_API_ENABLED;
}
