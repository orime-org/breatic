// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Project reads supporting collab's lazy-seed.
 *
 * collab's `lazySeedMeta` runs from only a doc name (→ projectId) and
 * must learn the Space type chosen at create time and whether the Project
 * is a copy still being copied, both on the business `projects` row. Like `core/auth/projectMembers.repo` (the
 * shared `project_members` read collab's auth already uses), this is a
 * thin core read so collab never reaches the server's project repo
 * across the service boundary.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@core/db/client.js";
import { projects } from "@core/db/schema.js";
import type { SpaceKind } from "@core/db/yjs-bootstrap.js";

/** What lazy-seed needs to know about a Project before it seeds the meta document. */
export interface SeedFacts {
  /** The Space type chosen at create time, or `"canvas"` when the row is missing or soft-deleted (the column's own default). */
  kind: SpaceKind;
  /** A copy whose documents collab has not copied yet (inner#1706): it names a source and has no completion. */
  copying: boolean;
}

/**
 * Read, in one query, a Project's initial Space type and whether it is a copy still being copied.
 * @param projectId - Project UUID
 * @returns The facts; a missing or soft-deleted row reads as a canvas Project that is not being copied
 * @throws {Error} When the database query fails.
 */
export async function loadSeedFacts(projectId: string): Promise<SeedFacts> {
  const [row] = await db
    .select({ t: projects.initialSpaceType, from: projects.duplicatedFromId, at: projects.duplicateCompletedAt })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return {
    kind: (row?.t as SpaceKind | undefined) ?? "canvas",
    copying: row !== undefined && row.from !== null && row.at === null,
  };
}
