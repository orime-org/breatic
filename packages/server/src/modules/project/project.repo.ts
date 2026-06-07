// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project repository — data access with soft delete support.
 *
 * v10 schema: project belongs to a Studio (the studio that pays for /
 * houses it). Owner / role information lives in `project_members`,
 * not on the project row. `created_by_user_id` is an immutable audit
 * field — used only for "creator" UI display and never for
 * permission decisions; permission lookups go through
 * `projectAuth.loadProjectRole`.
 *
 * The legacy `canvas_data` JSONB snapshot was dropped: live canvas
 * state is in Yjs documents (`project-{id}/canvas-{spaceId}`) and
 * the `yjs_documents` table.
 */

import { eq, and, isNull, isNotNull, or, desc } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { db } from "@breatic/core";
import { insertOutboxEvent } from "@server/modules/project/lifecycle-outbox.repo.js";
import {
  projects,
  studios,
  projectMembers,
  conversations,
  nodeHistory,
  projectMemories,
  projectMemoryEntries,
  tasks,
} from "@breatic/core";
import { cascadeDeleteConversations } from "@server/modules/conversation/conversation.repo.js";
import type {
  ProjectEntity,
  ProjectRole,
  ProjectSummary,
  ProjectVisibility,
  SpaceType,
} from "@breatic/shared";

/**
 * Map a raw `projects` table row to a `ProjectEntity` domain object.
 * @param row - Raw row selected from the `projects` table
 * @returns The mapped project entity
 */
function toEntity(row: typeof projects.$inferSelect): ProjectEntity {
  return {
    id: row.id,
    studioId: row.studioId,
    createdByUserId: row.createdByUserId,
    name: row.name,
    description: row.description,
    thumbnailUrl: row.thumbnailUrl,
    slug: row.slug,
    visibility: row.visibility as ProjectVisibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Get a project by ID (excludes soft-deleted).
 * @param id - Project UUID
 * @returns The project entity, or null if not found or soft-deleted
 */
export async function getProjectById(id: string): Promise<ProjectEntity | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * List a studio's projects visible to a viewer, each tagged with the
 * viewer's role (slice 2 — the studio container's "projects" tab).
 *
 * Open-baseline visibility (design doc §2.3), enforced server-side so a
 * private project is never shipped to a client that should not see it:
 *   - a studio **admin** (`isStudioAdmin = true`) sees every active project
 *     in the studio — including other members' private projects (governance,
 *     GitHub-org model);
 *   - a studio **member** sees every `visibility = 'studio'` project plus the
 *     private projects they hold an active `project_members` role on.
 *
 * Non-members are handled one layer up (`project.service.listByStudioForViewer`
 * short-circuits to `[]`), so this query is only reached for studio members.
 *
 * `myRole` comes from a LEFT JOIN on the viewer's ACTIVE membership row
 * (`deleted_at IS NULL` lives in the JOIN's ON clause, not the WHERE, so a
 * soft-deleted row simply yields no join → `myRole = null` rather than
 * dropping the project). A studio-visible project the viewer has not entered
 * yet has no row → `myRole = null` until they open it (which materializes a
 * viewer row — see `materializeBaselineViewer`).
 * @param studioId - Studio UUID whose projects to list
 * @param viewerUserId - The viewing user's UUID (resolves `myRole`)
 * @param isStudioAdmin - Whether the viewer is this studio's admin (sees all)
 * @returns The visible project summaries ordered by most recently updated
 */
export async function listProjectsByStudioForViewer(
  studioId: string,
  viewerUserId: string,
  isStudioAdmin: boolean,
): Promise<ProjectSummary[]> {
  const rows = await db
    .select({
      id: projects.id,
      studioId: projects.studioId,
      name: projects.name,
      slug: projects.slug,
      visibility: projects.visibility,
      thumbnailUrl: projects.thumbnailUrl,
      myRole: projectMembers.role,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, viewerUserId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .where(
      and(
        eq(projects.studioId, studioId),
        isNull(projects.deletedAt),
        isStudioAdmin
          ? undefined
          : or(
              eq(projects.visibility, "studio"),
              isNotNull(projectMembers.role),
            ),
      ),
    )
    .orderBy(desc(projects.updatedAt));

  return rows.map((row) => ({
    id: row.id,
    studioId: row.studioId,
    name: row.name,
    slug: row.slug,
    visibility: row.visibility as ProjectVisibility,
    thumbnailUrl: row.thumbnailUrl,
    myRole: (row.myRole as ProjectRole | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Drizzle transaction handle as it appears inside a `db.transaction(...)`
 * callback. Loose typing because the underlying generic is internal
 * to drizzle-orm and not part of the public surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgTransaction<any, any, any>;

/**
 * Create a new project and the corresponding owner row in
 * `project_members`.
 *
 * Both writes happen on the caller-supplied `tx` so they participate
 * in whatever larger transaction the service layer is composing
 * (typically: project + owner row + initial Yjs meta state, all in
 * one atomic unit so "project exists ⇒ owner exists ⇒ default Space
 * exists" is an invariant established at creation time).
 *
 * The owner row must land in the same transaction as the project row
 * — leaving a project without an owner row would make the project
 * effectively orphaned (no member can read it, including its own
 * creator). The partial unique index in `project_members` enforces
 * "exactly one owner per active project".
 * @param tx - Drizzle transaction handle from a surrounding
 *   `db.transaction(async tx => ...)` block in the service layer
 * @param studioId - Studio that the project belongs to
 * @param creatorUserId - User who created the project (becomes owner)
 * @param name - Project name
 * @param slug - URL slug for `/project/{slug}-{uuid}` (format-validated
 *   app-side, NOT unique)
 * @param visibility - `'studio'` (open baseline) | `'private'` (explicit
 *   members only)
 * @param spaceType - Initial Space type stored on the row; collab seeds
 *   the first Space's content doc of this type on first load
 * @param description - Optional description
 * @returns The freshly created project entity
 */
export async function createProject(
  tx: Tx,
  studioId: string,
  creatorUserId: string,
  name: string,
  slug: string,
  visibility: ProjectVisibility,
  spaceType: SpaceType,
  description?: string,
): Promise<ProjectEntity> {
  const inserted = await tx
    .insert(projects)
    .values({
      studioId,
      createdByUserId: creatorUserId,
      name,
      slug,
      visibility,
      initialSpaceType: spaceType,
      description,
    })
    .returning();
  const project = inserted[0]!;

  await tx.insert(projectMembers).values({
    projectId: project.id,
    userId: creatorUserId,
    role: "owner",
    addedBy: null,
  });

  return toEntity(project);
}

/**
 * Update mutable project metadata (name / description / thumbnail).
 *
 * Only fields with a defined value are updated — `undefined` is
 * skipped so callers can PATCH a single field. `null` is a legal
 * value for `description` and `thumbnailUrl` and will clear them.
 * @param id - Project UUID
 * @param patch - Fields to update
 * @param patch.name - New project name
 * @param patch.description - New description; `null` clears it
 * @param patch.thumbnailUrl - New thumbnail URL; `null` clears it
 * @returns The updated project, or `null` if no row matched
 */
export async function updateProjectMeta(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    thumbnailUrl?: string | null;
  },
): Promise<ProjectEntity | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.thumbnailUrl !== undefined) set.thumbnailUrl = patch.thumbnailUrl;

  const rows = await db
    .update(projects)
    .set(set)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .returning();
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Duplicate a project and all of its Yjs documents inside a single
 * transaction.
 *
 * Copies (with a new project UUID):
 *   - The `projects` row (name with " (copy)" suffix, same
 *     description / thumbnail, same `studio_id`, new
 *     `created_by_user_id` = caller)
 *   - One `project_members` row with `role='owner'` for the caller
 *   - Every `yjs_documents` row whose name starts with
 *     `project-<sourceId>/` — rewriting the prefix to the new UUID
 *     so meta + every Canvas Space doc carries over (multi-doc
 *     layout per v10 spec §5.3)
 *
 * Does NOT copy:
 *   - Conversations, messages, tasks, or node_history (these belong
 *     to the user's past work; the duplicate starts with a fresh
 *     timeline)
 *   - Project / user memory rows (derived from past conversations
 *     the duplicate doesn't have)
 *   - `project_members` other than the owner (the duplicate is
 *     a fresh project with the caller as the only member)
 *
 * Asset URLs inside the Yjs blobs continue to point at the original
 * OSS / S3 objects. Duplication is metadata-only at the storage
 * layer; OSS de-dupes by content hash anyway.
 * @param creatorUserId - Owner of the new project (must match caller
 *   at the service layer — this repo function does NOT itself check
 *   ownership of the source; that happens in project.service.ts)
 * @param sourceId - UUID of the project to duplicate
 * @returns The freshly created project entity, or `null` if the
 *   source project does not exist or is soft-deleted
 */
export async function duplicateProject(
  creatorUserId: string,
  sourceId: string,
): Promise<ProjectEntity | null> {
  return db.transaction(async (tx) => {
    const sourceRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, sourceId), isNull(projects.deletedAt)))
      .limit(1);
    const source = sourceRows[0];
    if (!source) return null;

    const inserted = await tx
      .insert(projects)
      .values({
        studioId: source.studioId,
        createdByUserId: creatorUserId,
        name: `${source.name} (copy)`,
        slug: `${source.slug}-copy`.slice(0, 120),
        visibility: source.visibility,
        description: source.description,
        thumbnailUrl: source.thumbnailUrl,
      })
      .returning();
    const newProject = inserted[0]!;

    await tx.insert(projectMembers).values({
      projectId: newProject.id,
      userId: creatorUserId,
      role: "owner",
      addedBy: null,
    });

    // The Yjs document store is a SEPARATE database now, so the doc copy
    // can't ride this business tx. Enqueue a lifecycle command in the
    // same tx (atomic with the new project row); the relay forwards it
    // to collab, which copies `project-{sourceId}/*` → `project-{newId}/*`
    // in the yjs DB.
    await insertOutboxEvent(tx, {
      type: "project:duplicated",
      sourceId,
      newId: newProject.id,
      ts: Date.now(),
    });

    return toEntity(newProject);
  });
}

/**
 * Soft-delete a project and every record that belongs to it.
 *
 * BUG-020 switched every child FK to `onDelete: restrict`, which means
 * Postgres refuses to hard-delete a project while children reference
 * it. Setting `deleted_at` on the project row alone left children with
 * `deleted_at IS NULL` and they kept showing up in list queries —
 * BUG-031 closed that gap for the project's direct children, and
 * BUG-142 closes it again for the conversation's grandchildren
 * (conversation_attachments / conversation_memories / memory_history_entries)
 * by delegating to {@link cascadeDeleteConversations}.
 *
 * Every child UPDATE is guarded with `isNull(deletedAt)` so we never
 * overwrite a previously-stamped timestamp if the same project is
 * deleted twice.
 *
 * Reference-only memory entries (`user_memory_entries.source_conversation_id`,
 * `project_memory_entries.source_conversation_id`) are NOT rewritten
 * here — see the rationale in `cascadeDeleteConversations`.
 *
 * yjs_documents is special: it has no FK to `projects`, only a string
 * `name` key shaped like `project-{id}/...` (the v10 multi-doc layout
 * uses meta + canvas-{sid} sub-paths). We soft-delete every row whose
 * name starts with the project prefix.
 *
 * project_members is also soft-deleted in this transaction so the
 * partial unique index "one active owner per project" is freed up if
 * the project is ever recreated under the same id (it isn't, but the
 * invariant is principled).
 * @param id - UUID of the project to soft-delete
 */
export async function deleteProject(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();

    const convRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.projectId, id), isNull(conversations.deletedAt)),
      );
    const convIds = convRows.map((r) => r.id);
    await cascadeDeleteConversations(tx, convIds, now);

    await tx
      .update(nodeHistory)
      .set({ deletedAt: now })
      .where(and(eq(nodeHistory.projectId, id), isNull(nodeHistory.deletedAt)));

    await tx
      .update(tasks)
      .set({ deletedAt: now })
      .where(and(eq(tasks.projectId, id), isNull(tasks.deletedAt)));

    await tx
      .update(projectMemories)
      .set({ deletedAt: now })
      .where(and(eq(projectMemories.projectId, id), isNull(projectMemories.deletedAt)));

    await tx
      .update(projectMemoryEntries)
      .set({ deletedAt: now })
      .where(
        and(eq(projectMemoryEntries.projectId, id), isNull(projectMemoryEntries.deletedAt)),
      );

    await tx
      .update(projectMembers)
      .set({ deletedAt: now })
      .where(
        and(
          eq(projectMembers.projectId, id),
          isNull(projectMembers.deletedAt),
        ),
      );

    // The Yjs document store is a SEPARATE database now, so its cascade
    // can't ride this business tx. Enqueue a lifecycle command in the
    // same tx (atomic with the project soft-delete); the relay forwards
    // it to collab, which soft-deletes `project-{id}/*` in the yjs DB +
    // kicks live connections. The data-leak invariant does NOT depend on
    // this async step: collab's auth hook reads the BUSINESS db, so the
    // moment this tx commits, `loadProjectRole` returns null and refuses
    // every new WebSocket — before any yjs read.
    await insertOutboxEvent(tx, {
      type: "project:deleted",
      projectId: id,
      ts: now.getTime(),
    });

    await tx
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(projects.id, id));
  });
}

// `studios` is referenced indirectly via `projects.studioId`. Re-export
// the studios table for `studioRepo.getByOwnerUserId` patterns elsewhere.
// Keep this module's public surface focused on `projects` though;
// studio CRUD lives in `studio.repo.ts`.
export { studios };
