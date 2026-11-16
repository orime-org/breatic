// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a process runs among the deployment's regions (inner#1955): the one
 * place that answers whether it is the global region and whether the
 * deployment has other regions at all. Each answer reads the settings it is
 * given, so a caller passes its own `env`.
 */

/** The region settings these answers read. */
export interface RegionPlacement {
  REGION: string;
  GLOBAL_REGION: string;
  REGION_API_URLS: Record<string, string>;
}

/**
 * Whether a process runs in the region that holds the global data.
 * @param config - Its region settings, usually `env`.
 * @returns True in the global region, and in every single-region deployment.
 */
export function isGlobalRegion(config: Pick<RegionPlacement, "REGION" | "GLOBAL_REGION">): boolean {
  return config.REGION === config.GLOBAL_REGION;
}

/**
 * The regions besides this one that a deployment reaches.
 * @param config - The deployment's region settings.
 * @returns Their codes.
 */
export function otherRegionsOf(config: RegionPlacement): string[] {
  return Object.keys(config.REGION_API_URLS).filter((region) => region !== config.REGION);
}

/**
 * Whether a deployment has more than one region.
 * @param config - The deployment's region settings.
 * @returns True outside the global region, or in a global region that reaches others.
 */
export function isMultiRegion(config: RegionPlacement): boolean {
  return config.REGION !== config.GLOBAL_REGION || otherRegionsOf(config).length > 0;
}
