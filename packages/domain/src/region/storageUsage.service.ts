// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storage across regions (inner#1955). Each region reports what its Studios
 * use; an admin's ceiling is checked against every region's usage, with the
 * calling region's own usage read live there.
 */

import { db, getStudioStorageQuota, studioDirectoryRepo } from "@breatic/core";

/** A region's report of what its Studios use. */
export interface RegionUsageReport {
  region: string;
  asOf: Date;
  usage: { studioId: string; bytes: number }[];
}

/** The part of a Studio's storage decision the global region answers. */
export interface StorageBudget {
  /** Whoever administers the Studio, whose ceiling and Studios count. */
  adminUserId: string;
  /** The ceiling in bytes; null while the admin's tier has none. */
  storageBytes: number | null;
  /** What the admin's Studios in every other region use. */
  elsewhereBytes: number;
}

/**
 * Record a region's report, keeping the newest one per Studio and region.
 * @param report - The report.
 * @returns Once recorded.
 */
export async function recordRegionUsage(report: RegionUsageReport): Promise<void> {
  const asOf = new Date(report.asOf);
  await db.transaction((tx) => studioDirectoryRepo.recordRegionUsage(report.region, asOf, report.usage, tx));
}

/**
 * The ceiling of a Studio's admin and what the admin's Studios use outside
 * the calling region. Runs in the global region.
 * @param studioId - The Studio the bytes land in.
 * @param callerRegion - The region that reads its own usage live.
 * @returns The budget.
 * @throws {Error} When the Studio has no live admin.
 */
export async function getStorageBudget(studioId: string, callerRegion: string): Promise<StorageBudget> {
  const { adminUserId, storageBytes } = await getStudioStorageQuota(studioId);
  const elsewhereBytes = storageBytes === null ? 0 : await studioDirectoryRepo.sumUsageElsewhere(adminUserId, callerRegion);
  return { adminUserId, storageBytes, elsewhereBytes };
}
