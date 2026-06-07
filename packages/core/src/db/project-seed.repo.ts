// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project reads supporting collab's lazy-seed.
 *
 * collab's `lazySeedMeta` runs from only a doc name (→ projectId) and
 * must learn the Space type chosen at create time, which lives on the
 * business `projects` row. Like `core/auth/projectMembers.repo` (the
 * shared `project_members` read collab's auth already uses), this is a
 * thin core read so collab never reaches the server's project repo
 * across the service boundary.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@core/db/client.js";
import { projects } from "@core/db/schema.js";
import type { SpaceKind } from "@core/db/yjs-bootstrap.js";

/**
 * Read a project's initial Space type — the type chosen at create time
 * and stored on `projects.initial_space_type`.
 * @param projectId - Project UUID
 * @returns The stored Space kind, or `"canvas"` when the project row is
 *   missing / soft-deleted (the column's own default), so seeding always
 *   has a valid kind
 */
export async function loadInitialSpaceType(
  projectId: string,
): Promise<SpaceKind> {
  const rows = await db
    .select({ t: projects.initialSpaceType })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return (rows[0]?.t as SpaceKind | undefined) ?? "canvas";
}
