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

const PROJECT_CACHE_PREFIX = 'breatic:region:project:';

const projectRegions = new Map<string, string | null>();

const studioRegions = new Map<string, string | null>();

/**
 * Remember which region a Project lives in. Its id never changes, so the
 * answer is also kept in localStorage for a reopened page.
 * @param id - The Project id.
 * @param region - Its region; null is the global region.
 */
export function rememberProjectRegion(id: string, region: string | null): void {
  projectRegions.set(id, region);
  try {
    window.localStorage.setItem(PROJECT_CACHE_PREFIX + id, region ?? '');
  } catch {
    // Storage unavailable: this tab still knows it.
  }
}

/**
 * The region a Project lives in, when this tab knows it.
 * @param id - The Project id.
 * @returns Its region (null for the global region), or undefined when unknown.
 */
export function projectRegionOf(id: string): string | null | undefined {
  const known = projectRegions.get(id);
  if (known !== undefined) return known;
  try {
    const stored = window.localStorage.getItem(PROJECT_CACHE_PREFIX + id);
    if (stored !== null) return stored === '' ? null : stored;
  } catch {
    // Storage unavailable: unknown.
  }
  return undefined;
}

/**
 * Remember which region a Studio lives in, under its id and its slug. Kept
 * only for this tab: a slug can later belong to another Studio.
 * @param keys - The Studio's id and slug, whichever are known.
 * @param region - Its region; null is the global region.
 */
export function rememberStudioRegion(keys: readonly string[], region: string | null): void {
  for (const key of keys) studioRegions.set(key, region);
}

/**
 * The region a Studio lives in, when this tab knows it.
 * @param key - The Studio's id or slug.
 * @returns Its region (null for the global region), or undefined when unknown.
 */
export function studioRegionOf(key: string): string | null | undefined {
  return studioRegions.get(key);
}

/** What a request says about the Project or Studio it acts on. */
export interface RequestTarget {
  url?: string | undefined;
  params?: unknown;
  data?: unknown;
}

/**
 * A string field of a plain object or URLSearchParams, if present.
 * @param source - The params or body.
 * @param name - The field.
 * @returns Its value, or undefined.
 */
function fieldOf(source: unknown, name: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(name) ?? undefined;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const value = (source as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The region of the Project or Studio a request acts on: named in its path
 * (`/projects/:id`, `/studio/:slug`) or in a `project_id` or `studio_id`
 * field of its query or body.
 * @param target - The request.
 * @returns The region, or undefined when the request names none this tab knows.
 */
function regionOfTarget(target: RequestTarget): string | null | undefined {
  const path = /^\/(projects|studio)\/([^/?]+)/.exec(target.url ?? '');
  if (path !== null) {
    const id = decodeURIComponent(path[2]!);
    const region = path[1] === 'projects' ? projectRegionOf(id) : studioRegionOf(id);
    if (region !== undefined) return region;
  }
  const projectId = fieldOf(target.params, 'project_id') ?? fieldOf(target.data, 'project_id');
  if (projectId !== undefined) return projectRegionOf(projectId);
  const studioId = fieldOf(target.params, 'studio_id') ?? fieldOf(target.data, 'studio_id');
  if (studioId !== undefined) return studioRegionOf(studioId);
  return undefined;
}

/**
 * The API base for one request (inner#1955): global data goes to the global
 * region; a request acting on a Project or Studio goes to that one's region,
 * whenever it is sent and whichever page is open by then; anything else goes
 * to the region of the open Studio or Project.
 * @param target - The request.
 * @param config - The region table, or null.
 * @returns The API base.
 * @throws {Error} When the table has no address for the region.
 */
export function apiBaseForRequest(target: RequestTarget, config: RegionConfig | null): string {
  if (config === null) return API_BASE_PATH;
  if (GLOBAL_API_PATHS.test(target.url ?? '')) return apiBaseFor(null, config);
  const region = regionOfTarget(target);
  return apiBaseFor(region === undefined ? currentRegion : region, config);
}

/**
 * The API base of the region a Project lives in, for a request whose body
 * does not name it (a transfer reference) or a follow-up keyed only by an
 * upload or a storage key.
 * @param projectId - The Project.
 * @param config - The region table, or null.
 * @returns The API base.
 * @throws {Error} When the table has no address for the region.
 */
export function apiBaseForProject(projectId: string, config: RegionConfig | null): string {
  return apiBaseForRequest({ data: { project_id: projectId } }, config);
}

/**
 * The API base for an invitation or decision token: the region its
 * `<region>.` prefix names, or the global region for a token without one,
 * whatever page is open; a prefix the table lacks goes to the global region.
 * @param token - The token from the link.
 * @param config - The region table, or null.
 * @returns The API base.
 */
export function apiBaseForToken(token: string, config: RegionConfig | null): string {
  if (config === null) return API_BASE_PATH;
  const prefix = /^([a-z0-9-]+)\./.exec(token)?.[1];
  // A prefix the table lacks names no region: the global region answers 404.
  return apiBaseFor(prefix !== undefined && Object.hasOwn(config.regions, prefix) ? prefix : null, config);
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
