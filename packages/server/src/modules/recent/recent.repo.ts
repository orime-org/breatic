// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import {
  projectLastOpened,
  projects,
  studios,
  projectMembers,
  studioMembers,
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
 * The access predicate mirrors the open-baseline model (recent-landing design
 * §4.2): a project is returned only if the viewer either
 *   - holds an active `project_members` row (private they're a member of, or a
 *     studio-visible project they have materialized into), OR
 *   - the project is `visibility = 'studio'` AND the viewer is an active
 *     member of the project's studio (open baseline, even with no row).
 * Soft-deleted projects / studios are excluded by the JOIN `ON` clauses. A
 * project that fails BOTH branches (kicked, turned-private-no-row, or another
 * user's private) is dropped — so a stale open row can never leak it.
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
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .leftJoin(
      studioMembers,
      and(
        eq(studioMembers.studioId, projects.studioId),
        eq(studioMembers.userId, userId),
        isNull(studioMembers.deletedAt),
      ),
    )
    .where(
      and(
        eq(projectLastOpened.userId, userId),
        or(
          isNotNull(projectMembers.role),
          and(
            eq(projects.visibility, "studio"),
            isNotNull(studioMembers.role),
          ),
        ),
      ),
    )
    .orderBy(desc(projectLastOpened.lastOpenedAt))
    .limit(limit);

  return rows.map((row) => ({
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    thumbnailUrl: row.thumbnailUrl,
    studioId: row.studioId,
    studioName: row.studioName,
    myRole: (row.myRole as ProjectRole | null) ?? null,
    lastOpenedAt: row.lastOpenedAt,
  }));
}
