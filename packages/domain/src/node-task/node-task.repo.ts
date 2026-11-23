// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data access for `node_tasks` (#186).
 *
 * Every state change carries its expected predecessor in the WHERE clause, so
 * two writers racing on one row cannot both win. The caller decides what an
 * affected-row count of zero means: a machine reporting a fact treats it as
 * "already settled, nothing to do", a user asking for an action treats it as
 * a refusal.
 */

import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db, type DbTx } from "@breatic/core";
import { nodeHistory, nodeTasks, tasks } from "@breatic/core";
import type { NodeTaskAction, SceneGenerationOrigin, SceneTaskNotice } from "@breatic/shared";

/** The four states a task can be in. */
export type NodeTaskStatus = "running" | "done" | "failed" | "expired";

/** What the node's corner shows: one number per state, and how many of the running wait for a slot. */
export interface NodeTaskCounts {
  running: number;
  /** Of `running`, the rows waiting for a free running slot (inner#1968). */
  waiting: number;
  /** The running-task limit the earliest waiting row's task waits under; absent while nothing waits (design 21 row 22). */
  waitingLimit?: number;
  done: number;
  failed: number;
  expired: number;
}

/** A task row as the list endpoint hands it out. */
export interface NodeTaskRow {
  id: string;
  projectId: string;
  spaceId: string;
  /** Null on a 3D Space's own row (inner#1690), which no node carries. */
  nodeId: string | null;
  kind: string;
  action: NodeTaskAction;
  status: NodeTaskStatus;
  startedByUserId: string;
  startedAt: Date;
  /** When it reached its end state; null while it runs. */
  settledAt: Date | null;
  budgetMs: number;
  label: string;
  errorMessage: string | null;
  nodeHistoryId: string | null;
  /** The registered model a Space-level row holds; null everywhere else. */
  assetId: string | null;
  /** Since when its task waits for a free running slot; null once it runs (inner#1968). Every read sets it. */
  waitingSince?: Date | null;
  /** The AIGC job the row runs as; null on an upload. Every read sets it. */
  taskId?: string | null;
  /** The running-task limit its task waits under (inner#1968); null when it does not wait. The list reads set it. */
  slotWaitLimit?: number | null;
}

/** A 3D Space's own row (inner#1690, inner#1691), as its list and its actions read it. */
export interface SceneTaskRow extends NodeTaskRow {
  /** The AIGC job a generation runs as; null on a model upload. */
  taskId: string | null;
  /** Where a generation was started from; null on a model upload. */
  origin: SceneGenerationOrigin | null;
  /** What the user is told beside a done generation; null when there is nothing to tell. */
  notice: SceneTaskNotice | null;
}

/**
 * A row as the list a user opens hands it out: the row plus what that task
 * put on the node.
 *
 * The result is read across from the history row the task names, and is
 * present on a task that landed something — which includes one judged expired
 * before its report arrived, since the bytes are real and the user must still
 * be able to pull them back (design §4.5). It rides on the list so replacing
 * the node's content costs no second request (design §3.5). It carries the
 * content, the history row's thumbnail as `coverUrl`, and the media numbers
 * the content landed on the node with (#2184), under the node's own field
 * names. The thumbnail is a video's cover, which a restore writes; for an
 * image it previews the content, and a restore writes null in its place.
 *
 * Every other read hands back the bare {@link NodeTaskRow}: settling a task
 * and clearing one have no use for what it landed, and a join they do not
 * read is a join nobody maintains.
 */
export interface NodeTaskListRow extends NodeTaskRow {
  content: string | null;
  coverUrl: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  duration: number | null;
  mimeType: string | null;
  size: number | null;
}

/**
 * A stored row as the reads hand it out.
 * @param row - The row as selected.
 * @returns The fields every read shares.
 */
function rowOf(row: typeof nodeTasks.$inferSelect): NodeTaskRow {
  return {
    id: row.id,
    projectId: row.projectId,
    spaceId: row.spaceId,
    nodeId: row.nodeId,
    kind: row.kind,
    action: row.action as NodeTaskAction,
    status: row.status as NodeTaskStatus,
    startedByUserId: row.startedByUserId,
    startedAt: row.startedAt,
    settledAt: row.settledAt,
    budgetMs: row.budgetMs,
    label: row.label,
    errorMessage: row.errorMessage,
    nodeHistoryId: row.nodeHistoryId,
    assetId: row.assetId,
    waitingSince: row.waitingSince,
    taskId: row.taskId,
  };
}

/**
 * A stored Space-level row as its reads hand it out.
 * @param row - The row as selected.
 * @returns The shared fields, the job, the origin and the notice.
 */
function sceneRowOf(row: typeof nodeTasks.$inferSelect): SceneTaskRow {
  return { ...rowOf(row), taskId: row.taskId, origin: row.origin as SceneGenerationOrigin | null,
    notice: row.notice as SceneTaskNotice | null };
}

/**
 * Read one row as a Space-level row, whatever state it is in.
 * @param taskId - Which row.
 * @returns The row, or null when the table holds no row without a node by that id.
 */
export async function findSceneRow(taskId: string): Promise<(SceneTaskRow & { deletedAt: Date | null }) | null> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(and(eq(nodeTasks.id, taskId), isNull(nodeTasks.nodeId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...sceneRowOf(row), deletedAt: row.deletedAt };
}

/**
 * Open a task in `running`.
 * @param data - Everything the row needs at birth.
 * @param data.projectId - Owning project.
 * @param data.spaceId - The space, so an event can name the document.
 * @param data.nodeId - The node this task runs on.
 * @param data.kind - `upload` or `generation`.
 * @param data.action - What the row's first line names.
 * @param data.startedByUserId - Who started it.
 * @param data.budgetMs - The conservative allowance the timer is set from.
 * @param data.label - Filename or model name, what the user reads.
 * @param data.taskId - The AIGC job; absent on uploads.
 * @param data.storageKey - The upload grant; absent on generations.
 * @param tx - Optional transaction shared with the upload grant.
 * @returns The new row's id.
 */
export async function insertRunning(data: {
  projectId: string;
  spaceId: string;
  nodeId: string;
  kind: string;
  action: NodeTaskAction;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  taskId?: string;
  storageKey?: string;
}, tx?: DbTx): Promise<string> {
  const rows = await (tx ?? db)
    .insert(nodeTasks)
    .values({ ...data, status: "running" })
    .returning({ id: nodeTasks.id });
  return rows[0]!.id;
}

/**
 * Move a running row to a terminal state.
 * @param taskId - Which task.
 * @param status - Where it lands.
 * @param fields - The result pointer or the reason, whichever applies.
 * @param fields.nodeHistoryId - The history row holding the result.
 * @param fields.assetId - The registered model a Space-level row lands with.
 * @param fields.errorMessage - Why it failed or timed out.
 * @param fields.notice - What the user is told beside a done Space-level generation.
 * @returns True when this call is the one that moved it.
 */
export async function settleRunning(
  taskId: string,
  status: Exclude<NodeTaskStatus, "running">,
  fields: { nodeHistoryId?: string; assetId?: string; errorMessage?: string; notice?: SceneTaskNotice | null },
): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    // The database clock, the same one `started_at` defaults to, so that the
    // two can be subtracted without an application host's drift in between.
    .set({ status, settledAt: sql`now()`, ...fields })
    .where(and(eq(nodeTasks.id, taskId), eq(nodeTasks.status, "running")))
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * A running row that does not wait for a free running slot: one that never
 * waited, or whose task no longer waits (inner#1968). A waiting row has no
 * deadline until its task starts; once the task ended without its rows being
 * settled (a cancel or a stale-waiter sweep that committed and then failed),
 * the row is judged by its budget like any other.
 * @returns The condition.
 */
function notWaitingForSlot(): SQL {
  return sql`(${nodeTasks.waitingSince} is null or not exists (select 1 from ${tasks} where ${tasks.id} = ${nodeTasks.taskId} and ${tasks.status} = 'pending'))`;
}

/**
 * Move every row on one node that outran its budget to `expired`.
 *
 * This is the whole of judging a task dead (#186, design §4.6): there is no
 * resident timer, so a row that ran past `started_at + budget_ms` keeps saying
 * `running` until this runs — which happens when somebody reads that node's
 * list, and nowhere else.
 *
 * Both sides of the comparison come from the database clock, the same one
 * `started_at` defaults to, so no application host's drift gets between them.
 * @param projectId - Owning project.
 * @param nodeId - The node whose list is being read.
 * @returns How many rows this call moved.
 */
export async function harvestExpired(
  projectId: string,
  nodeId: string,
): Promise<number> {
  const rows = await db
    .update(nodeTasks)
    .set({
      status: "expired",
      // The list shows a reason on every terminal row, and this row reached
      // its end without anybody reporting anything.
      errorMessage: "expired",
      settledAt: sql`now()`,
    })
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.nodeId, nodeId),
        isNull(nodeTasks.deletedAt),
        eq(nodeTasks.status, "running"),
        notWaitingForSlot(),
        sql`${nodeTasks.startedAt} + (${nodeTasks.budgetMs} * interval '1 millisecond') < now()`,
      ),
    )
    .returning({ id: nodeTasks.id });
  return rows.length;
}

/**
 * Attach a result to a row that already settled.
 *
 * The case this exists for: the deadline passed, the timer moved the row to
 * `expired`, and the report arrived after that. The bytes are in R2 and the
 * history row is written, so the result has to become reachable — while the
 * status stays where it is, because the user may already have retried and
 * choosing for them is not ours to do.
 * @param taskId - Which task.
 * @param nodeHistoryId - The history row now holding the result.
 * @returns True when the pointer was empty and this call filled it.
 */
export async function attachResult(
  taskId: string,
  nodeHistoryId: string,
): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ nodeHistoryId })
    .where(and(eq(nodeTasks.id, taskId), isNull(nodeTasks.nodeHistoryId)))
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * Hide a settled row from the list, keeping it in the table.
 * @param taskId - Which task.
 * @returns True when a settled, undeleted row was hidden.
 */
export async function softDeleteSettled(taskId: string): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(nodeTasks.id, taskId),
        isNull(nodeTasks.deletedAt),
        sql`${nodeTasks.status} <> 'running'`,
      ),
    )
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * Read one row whatever state it is in, including hidden ones.
 * @param taskId - Which task.
 * @returns The row, or null when the table does not hold it.
 */
export async function findById(taskId: string): Promise<
  | (NodeTaskRow & { deletedAt: Date | null })
  | null
> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(eq(nodeTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { ...rowOf(row), deletedAt: row.deletedAt };
}

/**
 * Find the task an upload grant belongs to.
 *
 * The report names a storage key and nothing else, so this is how the upload
 * leg gets from what the Worker said back to the row the ticket opened.
 * @param storageKey - The grant the bytes landed under.
 * @returns The row, or null when no task was opened for that key.
 */
export async function findByStorageKey(
  storageKey: string,
): Promise<NodeTaskRow | null> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(eq(nodeTasks.storageKey, storageKey))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return rowOf(row);
}

/**
 * When each row one job opened started, and the budget it opened with.
 * @param taskId - The job every row of that run points at.
 * @returns One entry per row, none when the job opened no row.
 */
export async function budgetsFor(taskId: string): Promise<Pick<NodeTaskRow, "startedAt" | "budgetMs" | "waitingSince">[]> {
  return db
    .select({ startedAt: nodeTasks.startedAt, budgetMs: nodeTasks.budgetMs, waitingSince: nodeTasks.waitingSince })
    .from(nodeTasks)
    .where(eq(nodeTasks.taskId, taskId));
}

/**
 * Find the row one job left on one node.
 *
 * A generation may write several nodes and each has its own row carrying the
 * shared job id, so the pair is what names exactly one of them.
 * @param taskId - The job every row of that run points at.
 * @param nodeId - The node just written to.
 * @returns The row, or null when that run opened none on that node.
 */
export async function findByTaskAndNode(
  taskId: string,
  nodeId: string,
): Promise<NodeTaskRow | null> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(and(eq(nodeTasks.taskId, taskId), eq(nodeTasks.nodeId, nodeId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return rowOf(row);
}

/**
 * Count the live rows on a node, one number per state.
 *
 * This is the whole of what the canvas document holds about tasks, so it is
 * recomputed after every state change rather than adjusted incrementally —
 * a number that is either current or stale cannot drift per entry.
 * @param projectId - Owning project.
 * @param nodeId - The node.
 * @param tx - Optional transaction reading its own newly opened row.
 * @returns The counts, zeros included.
 */
export async function countsFor(
  projectId: string,
  nodeId: string,
  tx?: DbTx,
): Promise<NodeTaskCounts> {
  const rows = await (tx ?? db)
    .select({
      status: nodeTasks.status,
      n: sql<string>`count(*)`,
      waiting: sql<string>`count(*) filter (where ${nodeTasks.waitingSince} is not null)`,
    })
    .from(nodeTasks)
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.nodeId, nodeId),
        isNull(nodeTasks.deletedAt),
      ),
    )
    .groupBy(nodeTasks.status);

  const counts: NodeTaskCounts = {
    running: 0,
    waiting: 0,
    done: 0,
    failed: 0,
    expired: 0,
  };
  for (const row of rows) {
    const key = row.status as NodeTaskStatus;
    if (key in counts) counts[key] = Number(row.n);
    if (key === "running") counts.waiting = Number(row.waiting);
  }
  if ((counts.waiting ?? 0) > 0) {
    // The limit the earliest waiting task waits under (design 21 row 22).
    const [first] = await (tx ?? db)
      .select({ limit: tasks.slotWaitLimit })
      .from(nodeTasks)
      .innerJoin(tasks, eq(tasks.id, nodeTasks.taskId))
      .where(
        and(
          eq(nodeTasks.projectId, projectId),
          eq(nodeTasks.nodeId, nodeId),
          eq(nodeTasks.status, "running"),
          isNotNull(nodeTasks.waitingSince),
          isNull(nodeTasks.deletedAt),
        ),
      )
      .orderBy(asc(nodeTasks.waitingSince))
      .limit(1);
    if (first?.limit != null) counts.waitingLimit = first.limit;
  }
  return counts;
}

/**
 * List the live rows on a node, newest first, each carrying what it landed.
 *
 * The result is read across from the history row a task names, so the browser
 * can replace the node's content from this one answer (design §3.5).
 * @param projectId - Owning project.
 * @param nodeId - The node.
 * @returns Every row the user may still act on.
 */
export async function listLive(
  projectId: string,
  nodeId: string,
): Promise<NodeTaskListRow[]> {
  const rows = await db
    .select({ task: nodeTasks, history: nodeHistory, limit: tasks.slotWaitLimit })
    .from(nodeTasks)
    .leftJoin(nodeHistory, eq(nodeHistory.id, nodeTasks.nodeHistoryId))
    .leftJoin(tasks, eq(tasks.id, nodeTasks.taskId))
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.nodeId, nodeId),
        isNull(nodeTasks.deletedAt),
      ),
    )
    .orderBy(sql`${nodeTasks.startedAt} DESC`);

  return rows.map(({ task, history, limit }) => ({
    ...rowOf(task),
    slotWaitLimit: task.waitingSince === null ? null : limit,
    content: history?.content ?? null,
    coverUrl: history?.thumbnailUrl ?? null,
    mediaWidth: history?.mediaWidth ?? null,
    mediaHeight: history?.mediaHeight ?? null,
    duration: history?.durationSeconds ?? null,
    mimeType: history?.mimeType ?? null,
    size: history?.sizeBytes ?? null,
  }));
}

/**
 * Open a 3D Space's own row (inner#1690): no node, the scene import action.
 * A dedup hit opens it already `done`, holding the asset it matched.
 * @param data - Everything the row needs at birth.
 * @param data.projectId - Owning project.
 * @param data.spaceId - The 3D Space whose list it joins.
 * @param data.startedByUserId - Who started it.
 * @param data.budgetMs - The allowance the deadline is read from.
 * @param data.label - The model name the user gave.
 * @param data.storageKey - The upload grant; absent on a dedup hit.
 * @param data.assetId - The matched asset, on a dedup hit only.
 * @param tx - Optional transaction shared with the upload grant.
 * @returns The new row's id.
 */
export async function insertSceneRow(data: {
  projectId: string;
  spaceId: string;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  storageKey?: string;
  assetId?: string;
}, tx?: DbTx): Promise<string> {
  const settled = data.assetId !== undefined;
  const rows = await (tx ?? db)
    .insert(nodeTasks)
    .values({
      ...data,
      nodeId: null,
      kind: "upload",
      action: "scene_import",
      status: settled ? "done" : "running",
      ...(settled && { settledAt: sql`now()` }),
    })
    .returning({ id: nodeTasks.id });
  return rows[0]!.id;
}

/**
 * Open a 3D Space's generation row (inner#1691): no node, the generate
 * action, the job it runs as and where it was started from.
 * @param data - Everything the row needs at birth.
 * @param data.projectId - Owning project.
 * @param data.spaceId - The 3D Space whose list it joins.
 * @param data.startedByUserId - Who submitted it.
 * @param data.budgetMs - The allowance the deadline is read from.
 * @param data.label - The cleaned prompt, the front image's name or the model's.
 * @param data.taskId - The AIGC job.
 * @param data.origin - The Space's own dialog, or an agent proposal.
 * @returns The new row's id.
 */
export async function insertSceneGenerationRow(data: {
  projectId: string;
  spaceId: string;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  taskId: string;
  origin: SceneGenerationOrigin;
}): Promise<string> {
  const rows = await db
    .insert(nodeTasks)
    .values({ ...data, nodeId: null, kind: "generation", action: "generate", status: "running" })
    .returning({ id: nodeTasks.id });
  return rows[0]!.id;
}

/**
 * Move every running row of one 3D Space that outran its budget to `expired`,
 * the Space-level counterpart of {@link harvestExpired}.
 * @param projectId - Owning project.
 * @param spaceId - The Space whose list is being read.
 * @returns How many rows this call moved.
 */
export async function harvestExpiredInSpace(projectId: string, spaceId: string): Promise<number> {
  const rows = await db
    .update(nodeTasks)
    .set({ status: "expired", errorMessage: "expired", settledAt: sql`now()` })
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.spaceId, spaceId),
        isNull(nodeTasks.nodeId),
        isNull(nodeTasks.deletedAt),
        eq(nodeTasks.status, "running"),
        notWaitingForSlot(),
        sql`${nodeTasks.startedAt} + (${nodeTasks.budgetMs} * interval '1 millisecond') < now()`,
      ),
    )
    .returning({ id: nodeTasks.id });
  return rows.length;
}

/**
 * The 3D Spaces with a running row whose budget runs out in `(from, to]` (#1580). The deadline sweep tells each one,
 * and the list read that follows expires the row ({@link harvestExpiredInSpace}); a round that could not tell them
 * finds the same Spaces again, since nothing here writes.
 * @param from - The window's open lower end.
 * @param to - The window's closed upper end.
 * @returns The Spaces, each once.
 */
export async function listScenesDueBetween(from: Date, to: Date): Promise<{ projectId: string; spaceId: string }[]> {
  const deadline = sql`${nodeTasks.startedAt} + (${nodeTasks.budgetMs} * interval '1 millisecond')`;
  return db
    .selectDistinct({ projectId: nodeTasks.projectId, spaceId: nodeTasks.spaceId })
    .from(nodeTasks)
    .where(
      and(
        isNull(nodeTasks.nodeId),
        isNull(nodeTasks.deletedAt),
        eq(nodeTasks.status, "running"),
        notWaitingForSlot(),
        sql`${deadline} > ${from.toISOString()}::timestamptz`,
        sql`${deadline} <= ${to.toISOString()}::timestamptz`,
      ),
    );
}

/**
 * List a 3D Space's live rows, newest first.
 * @param projectId - Owning project.
 * @param spaceId - The Space.
 * @returns Every row not removed.
 */
export async function listSpace(projectId: string, spaceId: string): Promise<SceneTaskRow[]> {
  const rows = await db
    .select({ task: nodeTasks, limit: tasks.slotWaitLimit })
    .from(nodeTasks)
    .leftJoin(tasks, eq(tasks.id, nodeTasks.taskId))
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.spaceId, spaceId),
        isNull(nodeTasks.nodeId),
        isNull(nodeTasks.deletedAt),
      ),
    )
    // Newest first by when the row was written, which is when it started;
    // `started_at` is the deadline's clock and is not what the list orders by.
    .orderBy(sql`${nodeTasks.createdAt} DESC`);
  return rows.map(({ task, limit }) => ({ ...sceneRowOf(task), slotWaitLimit: task.waitingSince === null ? null : limit }));
}

/**
 * Give a Space-level row the result that arrived after it expired.
 *
 * Only an expired row the user has not removed and that holds nothing yet
 * takes it: a failed row ended before any result, and a row that already
 * holds one keeps it.
 * @param taskId - Which task.
 * @param assetId - The registered model.
 * @param notice - What the user is told beside the model; null when nothing.
 * @returns True when this call wrote it.
 */
export async function attachAsset(taskId: string, assetId: string, notice: SceneTaskNotice | null): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ assetId, notice })
    .where(
      and(
        eq(nodeTasks.id, taskId),
        isNull(nodeTasks.nodeId),
        eq(nodeTasks.status, "expired"),
        isNull(nodeTasks.deletedAt),
        isNull(nodeTasks.assetId),
      ),
    )
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * Hide a Space-level row at a user's request: a failed row, or an expired one
 * that holds no result. A row holding a model stays, because the list is the
 * Space's reusable models.
 * @param taskId - Which task.
 * @returns True when this call hid it.
 */
export async function softDeleteSceneTask(taskId: string): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(nodeTasks.id, taskId),
        isNull(nodeTasks.nodeId),
        isNull(nodeTasks.deletedAt),
        sql`(${nodeTasks.status} = 'failed' OR (${nodeTasks.status} = 'expired' AND ${nodeTasks.assetId} IS NULL))`,
      ),
    )
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/** Where a row of one task sits: its node, or none for a 3D Space's own row. */
export interface TaskRowPlace {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string | null;
}

/**
 * Mark every running row of a task as waiting for a free running slot, keeping
 * a row that already waits as it is (inner#1968).
 * @param taskId - The AIGC job.
 * @param tx - The gate's transaction.
 * @returns The rows this call marked.
 */
export async function markWaiting(taskId: string, tx: DbTx): Promise<TaskRowPlace[]> {
  return tx
    .update(nodeTasks)
    .set({ waitingSince: sql`now()` })
    .where(and(eq(nodeTasks.taskId, taskId), eq(nodeTasks.status, "running"), isNull(nodeTasks.waitingSince)))
    .returning({ id: nodeTasks.id, projectId: nodeTasks.projectId, spaceId: nodeTasks.spaceId, nodeId: nodeTasks.nodeId });
}

/**
 * Start the waiting rows of a task: they stop waiting and count their budget
 * from now (inner#1968).
 * @param taskId - The AIGC job.
 * @param tx - The gate's transaction.
 * @returns The rows this call started.
 */
export async function startWaiting(taskId: string, tx: DbTx): Promise<TaskRowPlace[]> {
  return tx
    .update(nodeTasks)
    .set({ waitingSince: null, startedAt: sql`now()` })
    .where(and(eq(nodeTasks.taskId, taskId), eq(nodeTasks.status, "running"), sql`${nodeTasks.waitingSince} is not null`))
    .returning({ id: nodeTasks.id, projectId: nodeTasks.projectId, spaceId: nodeTasks.spaceId, nodeId: nodeTasks.nodeId });
}

/**
 * The rows of one task still running, on nodes or on a 3D Space.
 * @param taskId - The AIGC job.
 * @returns Each row's place.
 */
export async function listRunningForTask(taskId: string): Promise<TaskRowPlace[]> {
  return db
    .select({ id: nodeTasks.id, projectId: nodeTasks.projectId, spaceId: nodeTasks.spaceId, nodeId: nodeTasks.nodeId })
    .from(nodeTasks)
    .where(and(eq(nodeTasks.taskId, taskId), eq(nodeTasks.status, "running"), isNull(nodeTasks.deletedAt)));
}
