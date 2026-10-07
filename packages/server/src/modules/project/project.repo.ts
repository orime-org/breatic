// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { eq, and, isNull, isNotNull, desc, inArray, count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { db, projectMembersRepo } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import { insertOutboxEvent } from "@server/modules/project/lifecycle-outbox.repo.js";
import {
  projects,
  studios,
  projectInvitations,
  projectMembers,
  projectTransfers,
  roleUpgradeRequests,
  projectJoinRequests,
  projectLastOpened,
  projectEdits,
} from "@breatic/core";
import type {
  ProjectEntity,
  ProjectRole,
  ProjectSummary,
  SpaceType,
  StudioProjectSort,
} from "@breatic/shared";
import type {
  NameCollation,
  ProjectListCursor,
} from "@server/modules/project/project-list-cursor.js";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * Resolve project ids to their CURRENT name + slug, in one query.
 *
 * The read half of storing ids instead of names in notifications: the id is
 * immutable, so a renamed project still resolves to the right link. Soft-
 * deleted projects ARE returned, flagged `deleted`, so the caller can name the
 * target while dropping its link.
 * @param projectIds - Project UUIDs (deduped by the caller)
 * @returns Map of `projectId → { name, slug, deleted }`
 */
export async function getIdentitiesByProjectIds(
  projectIds: string[],
): Promise<Map<string, { name: string; slug: string; deleted: boolean }>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      deletedAt: projects.deletedAt,
    })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  return new Map(
    rows.map((r) => [
      r.id,
      { name: r.name, slug: r.slug, deleted: r.deletedAt !== null },
    ]),
  );
}

/**
 * Lock the project row for the length of a transaction that adds something to
 * it, and report whether it is still alive.
 *
 * Filing a request, an offer or an invite must not land on an archived (or
 * soft-deleted) project, and checking liveness without a lock does not achieve
 * that: the insert's own foreign key takes only `FOR KEY SHARE`, which does not
 * conflict with the archive's row update, so the two transactions run straight
 * past each other. The archive's sweep then cannot see the uncommitted row, and
 * what commits is a pending request on a project that takes none.
 *
 * `FOR UPDATE` on both sides is what makes them serialise. `archiveProject`
 * takes it first thing; a creator takes it and then finds either a live project
 * (and proceeds, with the archive waiting) or one that is not (and refuses).
 * @param id - Project UUID
 * @param tx - The creating transaction; the lock is meaningless without one
 * @returns `true` when the project is neither deleted nor archived, and is now locked
 */
export async function lockLiveProject(
  id: string,
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt), isNull(projects.archivedAt)))
    .for("update")
    .limit(1);
  return rows.length > 0;
}

/** How an archive or restore attempt ended. */
export type ArchiveOutcome = "done" | "missing" | "unchanged";

/**
 * Archive a project: stamp it, expire every pending request filed against it,
 * take their bell entries down, and queue the command that drops its live
 * connections — one transaction.
 *
 * ORDER IS LOAD-BEARING. The project row is locked first, as every path that
 * files, decides, withdraws or accepts a request against a project locks it
 * before its request rows. Taking a request table first would close a cycle
 * with any of them. A request filed concurrently waits on this lock and then
 * finds the project archived (`lockLiveProject` refuses it), so nothing pending
 * survives the sweep.
 *
 * The requests are expired, not deleted: the project comes back on restore,
 * and its history should say these lapsed.
 * @param id - Project UUID
 * @param byUserId - The studio admin archiving it
 * @param tx - The enclosing transaction
 * @returns `done`, `missing` when there is no live project row, or
 *   `unchanged` when it is already archived
 */
export async function archiveProject(
  id: string,
  byUserId: string,
  tx: DbTx,
): Promise<ArchiveOutcome> {
  const [row] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .for("update")
    .limit(1);
  if (!row) return "missing";
  if (row.archivedAt !== null) return "unchanged";

  const expire = {
    status: "expired",
    decidedAt: null,
  } as const;
  const notificationIds: string[] = [];
  /**
   * Keep the bell entry ids of the requests a sweep just expired.
   * @param rows - The swept rows' notification ids
   */
  const collect = (rows: { notificationId: string | null }[]): void => {
    for (const r of rows) if (r.notificationId !== null) notificationIds.push(r.notificationId);
  };

  collect(
    await tx
      .update(roleUpgradeRequests)
      .set({ ...expire, expiresAt: sql`LEAST(${roleUpgradeRequests.expiresAt}, now())` })
      .where(
        and(
          eq(roleUpgradeRequests.projectId, id),
          eq(roleUpgradeRequests.status, "pending"),
          isNull(roleUpgradeRequests.deletedAt),
        ),
      )
      .returning({ notificationId: roleUpgradeRequests.notificationId }),
  );
  collect(
    await tx
      .update(projectJoinRequests)
      .set({ ...expire, expiresAt: sql`LEAST(${projectJoinRequests.expiresAt}, now())` })
      .where(
        and(
          eq(projectJoinRequests.projectId, id),
          eq(projectJoinRequests.status, "pending"),
          isNull(projectJoinRequests.deletedAt),
        ),
      )
      .returning({ notificationId: projectJoinRequests.notificationId }),
  );
  collect(
    await tx
      .update(projectTransfers)
      .set({ ...expire, expiresAt: sql`LEAST(${projectTransfers.expiresAt}, now())` })
      .where(
        and(
          eq(projectTransfers.projectId, id),
          eq(projectTransfers.status, "pending"),
          isNull(projectTransfers.deletedAt),
        ),
      )
      .returning({ notificationId: projectTransfers.notificationId }),
  );
  collect(
    await tx
      .update(projectInvitations)
      .set({ status: "expired", expiresAt: sql`LEAST(${projectInvitations.expiresAt}, now())` })
      .where(
        and(
          eq(projectInvitations.projectId, id),
          eq(projectInvitations.status, "pending"),
          isNull(projectInvitations.deletedAt),
        ),
      )
      .returning({ notificationId: projectInvitations.notificationId }),
  );
  // Only these requests' own entries come down; the project's other unread
  // notifications stay, since the project comes back on restore.
  for (const notificationId of notificationIds) {
    await notificationRepo.retire(notificationId, tx);
  }

  const now = new Date();
  await tx
    .update(projects)
    .set({ archivedAt: now, archivedByUserId: byUserId, updatedAt: now })
    .where(eq(projects.id, id));
  await insertOutboxEvent(tx, { type: "project:archived", projectId: id, ts: now.getTime() });
  return "done";
}

/** What a restore did: `full` when the studio had no room for it. */
export type RestoreOutcome = ArchiveOutcome | "full";

/**
 * Restore an archived project and queue the command that drops its live
 * connections so they come back writable. The caller has already locked the
 * studio row. The project row is locked and found archived before the
 * studio's room is asked about, so a project that is already live is
 * answered as such even in a full studio.
 * @param id - Project UUID
 * @param tx - The enclosing transaction
 * @param hasRoom - Whether the studio can take one more live project
 * @returns `done`, `missing` when there is no live project row, `unchanged`
 *   when it is not archived, or `full` when the studio has no room
 */
export async function restoreProject(
  id: string,
  tx: DbTx,
  hasRoom: () => Promise<boolean>,
): Promise<RestoreOutcome> {
  const [row] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .for("update")
    .limit(1);
  if (!row) return "missing";
  if (row.archivedAt === null) return "unchanged";
  if (!(await hasRoom())) return "full";
  const now = new Date();
  await tx
    .update(projects)
    .set({ archivedAt: null, archivedByUserId: null, updatedAt: now })
    .where(eq(projects.id, id));
  await insertOutboxEvent(tx, { type: "project:restored", projectId: id, ts: now.getTime() });
  return "done";
}

/**
 * How many live projects a studio currently holds.
 *
 * Backs the per-studio project ceiling, whose value comes from the tier of
 * that studio's current admin. Archived projects do not count either: archiving
 * frees a slot, and restoring takes one back (the restore checks for room).
 * Soft-deleted projects do not count — the row stays for referential
 * integrity, but the capacity it occupied is released.
 *
 * A caller inside a transaction MUST pass it. Not for correctness — the studio
 * row is already locked by then, so no other request can have an uncommitted
 * insert in flight — but because a read issued without the handle reaches for
 * a second pooled connection while the first is still held, which is how a
 * pool exhausts itself under concurrent writes (same reason as
 * {@link getProjectById}).
 * @param studioId - Studio whose projects to count
 * @param tx - Enclosing transaction, when the caller is inside one
 * @returns The count of that studio's live projects
 */
export async function countLiveProjectsInStudio(
  studioId: string,
  tx?: DbTx,
): Promise<number> {
  const rows = await (tx ?? db)
    .select({ n: count() })
    .from(projects)
    .where(
      and(eq(projects.studioId, studioId), isNull(projects.deletedAt), isNull(projects.archivedAt)),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Load one active project by id.
 * Takes an optional transaction handle; a caller inside a transaction MUST pass
 * it, or the read reaches for a second pooled connection while the first is
 * still held (see `projectMembersRepo.getRole` for what that costs).
 * @param id - Project UUID
 * @param tx - Enclosing transaction, when the caller is inside one
 * @returns The project, or `null` when missing / soft-deleted
 */
export async function getProjectById(
  id: string,
  tx?: DbTx,
): Promise<ProjectEntity | null> {
  const rows = await (tx ?? db)
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** A studio's project as listed, before the caller's card permissions are added. */
export type StudioProjectRow = Omit<
  ProjectSummary,
  "canManageMeta" | "canDuplicate" | "canArchive" | "canRestore" | "canLeave"
>;

/** What one page of a studio's projects list is asked for with. */
export interface StudioProjectPageQuery {
  studioId: string;
  /** Resolves `myRole` and whose open times count. */
  viewerUserId: string;
  /** The archived list instead of the live one. */
  archived: boolean;
  sort: StudioProjectSort;
  /** Where the previous page stopped; null for the first page. */
  cursor: ProjectListCursor | null;
  limit: number;
  /** How names compare, for the name sort. */
  collation: NameCollation;
}

/** One page of rows, the cursor after its last row, and the list's size. */
export interface StudioProjectRowPage {
  rows: StudioProjectRow[];
  next: ProjectListCursor | null;
  total: number;
}

/**
 * One page of a studio's projects, in the requested sort, each tagged with
 * the viewer's role (the studio container's "projects" and "archived" tabs).
 *
 * Every studio member sees every project; non-members are handled one layer
 * up (`project.service.listByStudioForViewer` answers an empty page), so this
 * is only reached for studio members. `myRole` comes from a LEFT JOIN on the
 * viewer's active membership row, `lastOpenedAt` from the viewer's own
 * `project_last_opened` row, and the edit time from `project_edits`, falling
 * back to the creation time for a project never edited.
 *
 * Each sort ends on `id`, so rows sharing a sort value still have one order
 * and a page boundary between them loses or repeats nothing. One row more than
 * the page is read to know whether another page follows.
 * @param q - What to list; see {@link StudioProjectPageQuery}
 * @returns The page's rows, the cursor for the next page, and the list's size
 */
export async function listStudioProjectPage(
  q: StudioProjectPageQuery,
): Promise<StudioProjectRowPage> {
  const openedAt = projectLastOpened.lastOpenedAt;
  const editedAt = sql<Date>`COALESCE(${projectEdits.lastEditedAt}, ${projects.createdAt})`;
  const name = sql`${projects.name} COLLATE ${sql.raw(`"${q.collation}"`)}`;
  const listFilter = and(
    eq(projects.studioId, q.studioId),
    isNull(projects.deletedAt),
    q.archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
  );

  const order: SQL[] = {
    opened: [sql`${openedAt} IS NULL`, sql`${openedAt} DESC`, desc(projects.createdAt), desc(projects.id)],
    edited: [sql`${editedAt} DESC`, desc(projects.id)],
    name: [sql`${name} ASC`, sql`${projects.id} ASC`],
    created: [desc(projects.createdAt), desc(projects.id)],
    archived: [desc(projects.archivedAt), desc(projects.id)],
  }[q.sort];

  const rows = await db
    .select({
      id: projects.id,
      studioId: projects.studioId,
      name: projects.name,
      slug: projects.slug,
      thumbnailUrl: projects.thumbnailUrl,
      myRole: projectMembers.role,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      archivedAt: projects.archivedAt,
      lastOpenedAt: openedAt,
      lastEditedAt: editedAt,
      createdAtText: sql<string>`${projects.createdAt}::text`,
      openedAtText: sql<string | null>`${openedAt}::text`,
      editedAtText: sql<string>`${editedAt}::text`,
      archivedAtText: sql<string | null>`${projects.archivedAt}::text`,
    })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, q.viewerUserId),
        isNull(projectMembers.deletedAt),
      ),
    )
    .leftJoin(
      projectLastOpened,
      and(eq(projectLastOpened.projectId, projects.id), eq(projectLastOpened.userId, q.viewerUserId)),
    )
    .leftJoin(projectEdits, eq(projectEdits.projectId, projects.id))
    .where(q.cursor ? and(listFilter, afterCursor(q.cursor, { openedAt, editedAt, name })) : listFilter)
    .orderBy(...order)
    .limit(q.limit + 1);

  const [counted] = await db.select({ total: count() }).from(projects).where(listFilter);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const next = rows.length > q.limit && last ? cursorAt(q.sort, q.collation, last) : null;
  return {
    rows: page.map((row) => ({
      id: row.id,
      studioId: row.studioId,
      name: row.name,
      slug: row.slug,
      thumbnailUrl: row.thumbnailUrl,
      myRole: (row.myRole as ProjectRole | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      lastOpenedAt: row.lastOpenedAt,
      lastEditedAt: new Date(row.lastEditedAt),
    })),
    next,
    total: Number(counted?.total ?? 0),
  };
}

/**
 * The condition "after this cursor" for the cursor's sort, written out as
 * AND/OR so each column keeps its own direction.
 * @param c - Where the previous page stopped
 * @param cols - The computed sort columns
 * @param cols.openedAt - The viewer's open time
 * @param cols.editedAt - The edit time, falling back to creation
 * @param cols.name - The name under the request's collation
 * @returns The WHERE fragment
 */
function afterCursor(
  c: ProjectListCursor,
  cols: { openedAt: SQL | typeof projectLastOpened.lastOpenedAt; editedAt: SQL; name: SQL },
): SQL {
  /**
   * A cursor's full-precision timestamp text as a timestamptz.
   * @param v - The text
   * @returns The SQL value
   */
  const ts = (v: string): SQL => sql`${v}::timestamptz`;
  switch (c.s) {
    case "opened": {
      const createdAfter = sql`(${projects.createdAt} < ${ts(c.createdAt)} OR (${projects.createdAt} = ${ts(c.createdAt)} AND ${projects.id} < ${c.id}))`;
      if (c.openedAt === null) return sql`(${cols.openedAt} IS NULL AND ${createdAfter})`;
      return sql`((${cols.openedAt} IS NOT NULL AND (${cols.openedAt} < ${ts(c.openedAt)} OR (${cols.openedAt} = ${ts(c.openedAt)} AND ${createdAfter}))) OR ${cols.openedAt} IS NULL)`;
    }
    case "edited":
      return sql`(${cols.editedAt} < ${ts(c.editedAt)} OR (${cols.editedAt} = ${ts(c.editedAt)} AND ${projects.id} < ${c.id}))`;
    case "name":
      return sql`(${cols.name} > ${c.name} OR (${cols.name} = ${c.name} AND ${projects.id} > ${c.id}))`;
    case "created":
      return sql`(${projects.createdAt} < ${ts(c.createdAt)} OR (${projects.createdAt} = ${ts(c.createdAt)} AND ${projects.id} < ${c.id}))`;
    case "archived":
      return sql`(${projects.archivedAt} < ${ts(c.archivedAt)} OR (${projects.archivedAt} = ${ts(c.archivedAt)} AND ${projects.id} < ${c.id}))`;
  }
}

/** The text forms of a row's sort values, at full precision. */
interface CursorSource {
  id: string;
  name: string;
  createdAtText: string;
  openedAtText: string | null;
  editedAtText: string;
  archivedAtText: string | null;
}

/**
 * The cursor that continues after a row.
 * @param sort - The page's sort
 * @param collation - The page's name collation
 * @param row - The page's last row
 * @returns The cursor
 */
function cursorAt(sort: StudioProjectSort, collation: NameCollation, row: CursorSource): ProjectListCursor {
  switch (sort) {
    case "opened":
      return { s: "opened", openedAt: row.openedAtText, createdAt: row.createdAtText, id: row.id };
    case "edited":
      return { s: "edited", editedAt: row.editedAtText, id: row.id };
    case "name":
      return { s: "name", collation, name: row.name, id: row.id };
    case "created":
      return { s: "created", createdAt: row.createdAtText, id: row.id };
    case "archived":
      // Only the archived list sorts by it, where every row carries the time.
      return { s: "archived", archivedAt: row.archivedAtText ?? "", id: row.id };
  }
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
      initialSpaceType: spaceType,
      description,
    })
    .returning();
  const project = inserted[0]!;

  await projectMembersRepo.insertOwner(project.id, creatorUserId, tx);

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
 * @param tx - The transaction to write in; the shared pool when omitted
 * The write carries `archived_at IS NULL`, so it lands only on a live project
 * and serialises with an archive on the same row.
 * @returns The updated project, or `null` if no live, unarchived row matched
 */
export async function updateProjectMeta(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    thumbnailUrl?: string | null;
  },
  tx?: DbTx,
): Promise<ProjectEntity | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.thumbnailUrl !== undefined) set.thumbnailUrl = patch.thumbnailUrl;

  const rows = await (tx ?? db)
    .update(projects)
    .set(set)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt), isNull(projects.archivedAt)))
    .returning();
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Duplicate a project.
 *
 * Writes, in the caller's transaction:
 *   - The `projects` row (named by the caller, same
 *     description / thumbnail, same `studio_id`, new
 *     `created_by_user_id` = caller)
 *   - One `project_members` row with `role='owner'` for the caller
 *   - An outbox command telling collab to copy the Yjs documents
 *
 * The Yjs documents are NOT copied here. They live in a separate database
 * that cannot join this transaction, so what happens in-band is the outbox
 * row; collab does the copy afterwards. This function DID copy them inline
 * until the two-database split (`46b31ce3`, 2026-06-03) took
 * `yjsDocumentsRepo.duplicateByProjectPrefix` out of it; the comment kept
 * saying so for two months after that stopped being true.
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
 *
 * The transaction is the CALLER'S. It used to be opened here, which left no
 * point at which the service could take the studio's row and check the
 * project ceiling before the insert — the copy lands in the source's studio
 * and counts against it exactly like a fresh project does.
 * @param tx - The enclosing transaction, opened by the service
 * @param creatorUserId - Owner of the new project (must match caller
 *   at the service layer — this repo function does NOT itself check
 *   ownership of the source; that happens in project.service.ts)
 * @param source - The project being copied, already loaded and verified live
 *   by the caller (which needs its `studioId` to know what to lock)
 * @param name - The copy's name, already fitted to the column by the caller
 * @returns The freshly created project entity
 */
export async function duplicateProject(
  tx: Tx,
  creatorUserId: string,
  source: ProjectEntity,
  name: string,
): Promise<ProjectEntity> {
  const inserted = await tx
    .insert(projects)
    .values({
      studioId: source.studioId,
      createdByUserId: creatorUserId,
      name,
      slug: `${source.slug}-copy`.slice(0, 120),
      description: source.description,
      thumbnailUrl: source.thumbnailUrl,
    })
    .returning();
  const newProject = inserted[0]!;

  await projectMembersRepo.insertOwner(newProject.id, creatorUserId, tx);

  // The Yjs document store is a SEPARATE database now, so the doc copy
  // can't ride this business tx. Enqueue a lifecycle command in the
  // same tx (atomic with the new project row); the relay forwards it
  // to collab, which copies `project-{sourceId}/*` → `project-{newId}/*`
  // in the yjs DB.
  await insertOutboxEvent(tx, {
    type: "project:duplicated",
    sourceId: source.id,
    newId: newProject.id,
    ts: Date.now(),
  });

  return toEntity(newProject);
}

// `studios` is referenced indirectly via `projects.studioId`. Re-export
// the studios table for `studioRepo.getByOwnerUserId` patterns elsewhere.
// Keep this module's public surface focused on `projects` though;
// studio CRUD lives in `studio.repo.ts`.
export { studios };
