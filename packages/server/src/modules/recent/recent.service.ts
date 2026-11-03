// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Recent service — the cross-studio "Recent" landing feed.
 *
 * Records project opens and serves each user their own recently-opened
 * projects (newest-first, per-user ordering). The access checks live here so
 * the routes stay thin translators (prohibition #1).
 */

import * as recentRepo from "@server/modules/recent/recent.repo.js";
import * as projectService from "@server/modules/project/project.service.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { accountActivityRepo, db, ValidationError, serverAnalyticsWanted, trackServerEvent } from "@breatic/core";
import { newId, t, type AccountActivityEntity, type ProjectVisitReceipt, type ProjectVisitLookup, type RecentItem } from "@breatic/shared";

/**
 * The landing window — how many recent items `listRecent` returns. A
 * backend-defined cap (spec §4.2 says ~6; 12 gives the landing grid breathing
 * room without unbounded growth).
 */
const RECENT_LIMIT = 12;

/**
 * Record that `userId` just opened `projectId`.
 *
 * Access-gated: the caller must be able to view the project, or the open is
 * rejected (and nothing is written) — so a client cannot seed open rows for
 * projects it has no business touching. In the real flow this is always
 * reachable because the project-load path (`GET /projects/:id`) has already
 * admitted the member before the page records the open.
 * @param projectId - The opened project's UUID (untrusted client input)
 * @param userId - The authenticated user's UUID
 * @param visitId - Stable original page entry, generated for legacy callers.
 * @returns Original access receipt without replaying its business writes.
 * @throws {NotFoundError} when the caller cannot access the project (collapses
 *   missing / no-membership into 404 so project existence is not leaked)
 */
export async function recordOpen(
  projectId: string,
  userId: string,
  visitId: string = newId(),
): Promise<ProjectVisitReceipt> {
  const existing = await accountActivityRepo.findVisit(userId, visitId);
  if (existing) return visitReceipt(existing, projectId);
  await projectService.assertAccess(projectId, userId, "viewer");
  const result = await db.transaction(async (tx) => {
    const claimed = await accountActivityRepo.recordActivity({ userId, projectId, kind: "project_access", visitId }, tx);
    const receipt = visitReceipt(claimed.activity, projectId);
    if (claimed.inserted) await recentRepo.upsertOpen(userId, projectId, new Date(receipt.occurred_at), tx);
    return { receipt, inserted: claimed.inserted };
  });
  if (result.inserted) await reportSession(projectId, userId);
  return result.receipt;
}

/**
 * Return only this account's historical receipt, without current Project access.
 * @param projectId - The requested Project binding.
 * @param userId - The authenticated account.
 * @param visitId - Original page entry UUID.
 * @returns A matching historical receipt or an unconfirmed identity tuple.
 * @throws {Error} When the database cannot read the original.
 */
export async function lookupOpen(projectId: string, userId: string, visitId: string): Promise<ProjectVisitLookup> {
  const activity = await accountActivityRepo.findVisit(userId, visitId);
  if (!activity || activity.projectId !== projectId) {
    return { status: "unconfirmed", account_id: userId, project_id: projectId, visit_id: visitId };
  }
  return { status: "recorded", ...visitReceipt(activity, projectId) };
}

/**
 * Preserve the original receipt while refusing cross-Project replay.
 * @param activity - The account's immutable original visit row.
 * @param projectId - Requested Project UUID.
 * @returns Original server binding and precision-preserving timestamp.
 * @throws {ValidationError} When the visit belongs to another Project.
 */
function visitReceipt(activity: AccountActivityEntity, projectId: string): ProjectVisitReceipt {
  if (activity.projectId !== projectId || !activity.visitId) throw new ValidationError(t("server.error.validation"));
  return { account_id: activity.userId, project_id: projectId, visit_id: activity.visitId, occurred_at: activity.occurredAt };
}

/**
 * Send `active_project_session`, counted once per user, project and UTC day.
 * @param projectId - The opened project
 * @param userId - Who opened it
 */
async function reportSession(projectId: string, userId: string): Promise<void> {
  if (!serverAnalyticsWanted()) return;
  const project = await projectRepo.getProjectById(projectId);
  if (!project) return;
  const day = new Date().toISOString().slice(0, 10);
  trackServerEvent("active_project_session", {
    userId,
    insertId: `session:${userId}:${projectId}:${day}`,
    properties: { studio_id: project.studioId, project_id: projectId },
  });
}

/**
 * List the user's recently-opened projects for the landing feed.
 *
 * Delegated to the repo, which applies the access filter in SQL (a project the
 * user can no longer reach is never returned). Ordered by the user's own
 * last-open time, newest-first, capped at {@link RECENT_LIMIT}.
 * @param userId - The authenticated user's UUID
 * @returns The accessible recent items (empty when the user has opened nothing)
 */
export async function listRecent(userId: string): Promise<RecentItem[]> {
  return recentRepo.listRecentForUser(userId, RECENT_LIMIT);
}
