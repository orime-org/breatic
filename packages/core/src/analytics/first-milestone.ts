// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An account's first agent turn, first generation and first project, each
 * reported once (inner#1442 design §4.8). The claim is an insert into
 * `analytics_milestones`, whose primary key lets exactly one of any number of
 * concurrent claims through; accounts that reached a milestone before this
 * shipped were claimed by migration 0097.
 */

import { claimMilestone } from "@core/analytics/milestone.repo.js";
import type { DbTx } from "@core/db/client.js";

/** The milestones an account reaches once. */
export type FirstMilestone = "first-agent" | "first-generation" | "first-project";

/**
 * Claim an account's first milestone of a kind. Claimed whatever the
 * account's consent and whatever the deployment sends, so a first reached
 * while analytics was off or unconfigured is not reported later as a first.
 * @param kind - Which milestone.
 * @param userId - The account.
 * @param tx - A transaction to claim it in.
 * @returns True when this call is the account's first.
 */
export async function claimFirstMilestone(kind: FirstMilestone, userId: string, tx?: DbTx): Promise<boolean> {
  return claimMilestone(`${kind}:${userId}`, tx);
}
