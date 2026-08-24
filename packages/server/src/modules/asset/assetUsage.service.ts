// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Account-level storage usage roll-up (#1826 §5.3).
 *
 * A studio owns its assets; an account owns studios. This service bridges the
 * two: it enumerates the studios an account controls — its personal studio ∪
 * every team studio it CURRENTLY administers — and sums their live asset bytes.
 * The team-studio set is decided by the current `admin` role (never the
 * immutable `created_by`), so a transfer moves a studio's contribution to the
 * new admin's total; enumeration reuses the same predicate as the creation
 * quota (studio.repo `listTeamStudioIdsAdministeredBy`). The sum is raw — since
 * dedup is per-studio, identical content held in two of the account's studios
 * is counted twice.
 */

import { assetRepo } from "@breatic/domain";
import * as studioRepo from "@server/modules/studio/studio.repo.js";

/**
 * Total live storage an account uses across all studios it controls, in bytes.
 * @param userId - The account (user) UUID
 * @returns The raw byte total over the account's personal ∪ administered team
 *   studios (0 when the account controls no studio with live assets)
 * @throws {Error} if the underlying studio / asset queries fail
 */
export async function accountStorageUsage(userId: string): Promise<number> {
  const personal = await studioRepo.getPersonalByCreator(userId);
  const teamIds = await studioRepo.listTeamStudioIdsAdministeredBy(userId);
  const studioIds = personal ? [personal.id, ...teamIds] : teamIds;
  return assetRepo.usageByStudios(studioIds);
}
