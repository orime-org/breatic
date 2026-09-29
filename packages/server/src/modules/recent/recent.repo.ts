// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Recent repository — the single home of the `project_last_opened` table.
 *
 * Backs the cross-studio "Recent" landing feed. Two operations:
 *   - {@link upsertOpen} records (or bumps) the viewer's last-open time for a
 *     project, composite-PK UPSERT so re-opening floats it to the top.
 *   - {@link listRecentForUser} returns the viewer's recently-opened projects,
 *     newest-first, ACCESS-FILTERED in SQL so a project the viewer can no
 *     longer reach is never returned (a CLAUDE.md critical path: auth + data
 *     integrity).
 *
 * Access is re-checked at read time (not trusted from the open row): a stale
 * open row for a project the viewer was kicked from, or another user's private
 * project, must be filtered out — see the WHERE predicate below.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import {
  projectLastOpened,
  projects,
  studios,
  projectMembers,
} from "@breatic/core";
import type { ProjectRole, RecentItem } from "@breatic/shared";

/**
 * Record that `userId` opened `projectId` now.
 *
 * Composite-PK UPSERT: a first open inserts a row; a re-open updates
 * `last_opened_at = now()` in place (no duplicate row, `created_at`
 * preserved as the first-open time). The caller is responsible for the
 * access check BEFORE calling this — the repo only writes.
 * @param userId - The viewing user's UUID
 * @param projectId - The opened project's UUID
 */
export async function upsertOpen(
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .insert(projectLastOpened)
    .values({ userId, projectId })
    .onConflictDoUpdate({
      target: [projectLastOpened.userId, projectLastOpened.projectId],
      set: { lastOpenedAt: sql`now()` },
    });
}

/**
 * List the viewer's recently-opened projects, newest-first, filtered to the
 * ones they can STILL access.
 *
 * A project is returned only while the viewer holds an active
 * `project_members` row on it — the same condition that lets them open it.
 * Soft-deleted projects / studios are excluded by the JOIN `ON` clauses, and a
 * project the viewer was removed from is dropped, so a stale open row never
 * leads to a project they cannot enter.
 * @param userId - The viewing user's UUID
 * @param limit - Maximum rows to return (the landing window)
 * @returns The accessible recent items, ordered by `last_opened_at` DESC
 */
export async function listRecentForUser(
  userId: string,
  limit: number,
): Promise<RecentItem[]> {
  const rows = await db
    .select({
      projectId: projects.id,
      name: projects.name,
      slug: projects.slug,
      thumbnailUrl: projects.thumbnailUrl,
      studioId: studios.id,
      studioName: studios.name,
      myRole: projectMembers.role,
      lastOpenedAt: projectLastOpened.lastOpenedAt,
    })
    .from(projectLastOpened)
    .innerJoin(
      projects,
      and(
        eq(projects.id, projectLastOpened.projectId),
        isNull(projects.deletedAt),
      ),
    )
    .innerJoin(
      studios,
      and(eq(studios.id, projects.studioId), isNull(studios.deletedAt)),
    )
    .innerJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .where(eq(projectLastOpened.userId, userId))
    .orderBy(desc(projectLastOpened.lastOpenedAt))
    .limit(limit);

  return rows.map((row) => ({
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    thumbnailUrl: row.thumbnailUrl,
    studioId: row.studioId,
    studioName: row.studioName,
    myRole: row.myRole as ProjectRole,
    lastOpenedAt: row.lastOpenedAt,
  }));
}
