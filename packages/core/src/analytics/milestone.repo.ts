// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Data access for `analytics_milestones`. */

import { db } from "@core/db/client.js";
import { analyticsMilestones } from "@core/db/schema.js";

/**
 * Claim a milestone that is reported once.
 * @param key - What it is about.
 * @returns True when this call claimed it; false when it was already claimed.
 */
export async function claimMilestone(key: string): Promise<boolean> {
  const rows = await db
    .insert(analyticsMilestones)
    .values({ key })
    .onConflictDoNothing()
    .returning({ key: analyticsMilestones.key });
  return rows.length > 0;
}
