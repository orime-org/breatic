// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Recent service — the cross-studio "Recent" landing feed.
 *
 * Records project opens and serves each user their own recently-opened
 * projects (newest-first, per-user ordering). The access checks live here so
 * the routes stay thin translators (prohibition #1).
 */

import * as recentRepo from "@server/modules/recent/recent.repo.js";
import * as projectService from "@server/modules/project/project.service.js";
import type { RecentItem } from "@breatic/shared";

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
 * admitted (and materialized) the viewer before the page records the open.
 * @param projectId - The opened project's UUID (untrusted client input)
 * @param userId - The authenticated user's UUID
 * @throws {NotFoundError} when the caller cannot access the project (collapses
 *   missing / no-membership into 404 so project existence is not leaked)
 */
export async function recordOpen(
  projectId: string,
  userId: string,
): Promise<void> {
  await projectService.assertAccess(projectId, userId, "viewer");
  await recentRepo.upsertOpen(userId, projectId);
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
