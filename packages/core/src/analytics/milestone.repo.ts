// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Data access for `analytics_milestones`. */

import { db, type DbTx } from "@core/db/client.js";
import { analyticsMilestones } from "@core/db/schema.js";

/**
 * Claim a milestone that is reported once.
 * @param key - What it is about.
 * @param tx - A transaction to claim it in, so the claim rolls back with it.
 * @returns True when this call claimed it; false when it was already claimed.
 */
export async function claimMilestone(key: string, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db)
    .insert(analyticsMilestones)
    .values({ key })
    .onConflictDoNothing()
    .returning({ key: analyticsMilestones.key });
  return rows.length > 0;
}
