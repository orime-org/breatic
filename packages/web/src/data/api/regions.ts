// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The region table the web build carries (inner#1955): which address serves
 * each region's API and collab, and which region the open Studio lives in.
 * A build without `VITE_REGIONS` has no table and keeps today's addresses.
 */

import { z } from 'zod';
import { GLOBAL_API_PATHS } from '@breatic/shared';

import { API_BASE_PATH } from '@web/data/api/base-path';
import { ApiException } from '@web/data/api/types';

const regionAddressSchema = z.object({ api: z.string().min(1), collab: z.string().min(1) });

const regionConfigSchema = z
  .object({ global: z.string().min(1), regions: z.record(z.string(), regionAddressSchema) })
  .refine((config) => config.regions[config.global] !== undefined, {
    message: 'the global region needs an address',
  });

/** The build's region table. */
export type RegionConfig = z.infer<typeof regionConfigSchema>;

/**
 * Read the build's region table.
 * @param raw - The `VITE_REGIONS` JSON; empty means none.
 * @returns The table, or null when the build has none.
 * @throws {Error} When the setting is malformed or the global region has no address.
 */
export function parseRegionConfig(raw: string | undefined): RegionConfig | null {
  if (raw === undefined || raw.trim() === '') return null;
  return regionConfigSchema.parse(JSON.parse(raw));
}

const BUILD_REGIONS = parseRegionConfig(import.meta.env.VITE_REGIONS);

/**
 * The region table this build carries.
 * @returns The table, or null in a single-region build.
 */
export function getRegionConfig(): RegionConfig | null {
  return BUILD_REGIONS;
}

/**
 * The addresses of one region; a Studio with no region is in the global one.
 * @param region - The region code, or null for the global region.
 * @param config - The region table.
 * @returns The region's addresses.
 * @throws {Error} When the table has no address for the region.
 */
function addressesOf(region: string | null, config: RegionConfig): z.infer<typeof regionAddressSchema> {
  const addresses = config.regions[region ?? config.global];
  if (addresses === undefined) throw new Error(`no address for region ${region}`);
  return addresses;
}

/**
 * The API base for a region.
 * @param region - The region code, or null for the global region.
 * @param config - The region table, or null for a single-region build.
 * @returns The API base, without a trailing slash.
 * @throws {Error} When the table has no address for the region.
 */
export function apiBaseFor(region: string | null, config: RegionConfig | null): string {
  if (config === null) return API_BASE_PATH;
  return addressesOf(region, config).api;
}

/**
 * The collab address for a region.
 * @param region - The region code, or null for the global region.
 * @param config - The region table, or null for a single-region build.
 * @returns The WebSocket URL, or undefined to keep the build's own address.
 * @throws {Error} When the table has no address for the region.
 */
export function collabUrlFor(region: string | null, config: RegionConfig | null): string | undefined {
  return config === null ? undefined : addressesOf(region, config).collab;
}

/** Time zones in the Americas' Pacific that stay with the global region. */
const US_PACIFIC = new Set(['Pacific/Honolulu', 'Pacific/Guam', 'Pacific/Saipan', 'Pacific/Pago_Pago', 'Pacific/Midway', 'Pacific/Johnston', 'Pacific/Wake']);

/**
 * The region a new Studio defaults to from the user's time zone.
 * @param timeZone - The IANA time zone.
 * @param config - The region table, or null for a single-region build.
 * @returns A region the table has, or undefined when there is no table.
 */
export function defaultRegionForTimeZone(timeZone: string, config: RegionConfig | null): string | undefined {
  if (config === null) return undefined;
  const asian = /^(Asia|Australia|Pacific)\//.test(timeZone) && !US_PACIFIC.has(timeZone);
  return asian && config.regions.sg !== undefined ? 'sg' : config.global;
}

/**
 * The region to put in a create request: none when there is nothing to choose.
 * @param region - The chosen region.
 * @param config - The region table, or null.
 * @returns The region, or undefined in a build with one region or none.
 */
export function regionToSend(region: string, config: RegionConfig | null): string | undefined {
  if (config === null || Object.keys(config.regions).length < 2) return undefined;
  return region;
}

let currentRegion: string | null = null;

/**
 * Set the region of the open Studio or Project; null is the global region.
 * @param region - The region code, or null.
 */
export function setCurrentRegion(region: string | null): void {
  currentRegion = region;
}

/**
 * The region of the open Studio or Project.
 * @returns The region code, or null for the global region.
 */
export function getCurrentRegion(): string | null {
  return currentRegion;
}

/**
 * The API base for one request path: global data goes to the global region,
 * everything else to the region of the open Studio or Project.
 * @param path - The request path under the API base.
 * @param config - The region table, or null.
 * @returns The API base.
 * @throws {Error} When the table has no address for the region.
 */
export function apiBaseForPath(path: string, config: RegionConfig | null): string {
  if (config === null) return API_BASE_PATH;
  return apiBaseFor(GLOBAL_API_PATHS.test(path) ? null : currentRegion, config);
}

/**
 * The API base for an invitation or decision token: the region its
 * `<region>.` prefix names, or the global region for a token without one,
 * whatever page is open.
 * @param token - The token from the link.
 * @param config - The region table, or null.
 * @returns The API base.
 * @throws {Error} When the table has no address for the named region.
 */
export function apiBaseForToken(token: string, config: RegionConfig | null): string {
  if (config === null) return API_BASE_PATH;
  const prefix = /^([a-z0-9-]+)\./.exec(token);
  return apiBaseFor(prefix ? prefix[1]! : null, config);
}

/**
 * Whether a failed request means the region holding the Studio or Project
 * did not answer: the network failed or the region said 503 (inner#1955).
 * @param err - What the request threw.
 * @returns True for a region that is down.
 */
export function isRegionDown(err: unknown): boolean {
  return err instanceof ApiException && (err.network || err.status === 503);
}
