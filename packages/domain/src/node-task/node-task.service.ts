// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The lifecycle of one task on a canvas node (#186).
 *
 * Two kinds of caller reach this service and they get different answers.
 *
 * A machine reporting a fact — the ingest Worker's report, a finished job, a
 * timer that went off — describes something that already happened. Refusing
 * it does not un-happen it, and the request it rides on usually carries more
 * than this row: `/assets/ingest-report` also registers the asset, writes
 * node_history and counts storage. So {@link settle} landing on a terminal
 * row reports `applied: false` and lets the caller carry on.
 *
 * A user asking for an action is different: {@link dismiss} on a running row
 * throws, because refusing it costs nothing. And a dismiss naming a row this
 * table does not hold carries on, because the user is acting on a projection
 * the server cannot see — whatever is on their screen, "clear this" means
 * clear it.
 *
 * Every answer carries the node's four counts, freshly recomputed. That is
 * the whole of what the canvas document holds about tasks, so the caller
 * always has what the next event needs.
 */

import { ConflictError } from "@breatic/core";
import { t } from "@breatic/shared";
import * as repo from "@domain/node-task/node-task.repo.js";
import type {
  NodeTaskCounts,
  NodeTaskListRow,
  NodeTaskRow,
  NodeTaskStatus,
} from "@domain/node-task/node-task.repo.js";

export type {
  NodeTaskCounts,
  NodeTaskListRow,
  NodeTaskRow,
  NodeTaskStatus,
};

/** What a state change hands back: what happened, and the new counts. */
export interface SettleResult {
  /** True when this call is the one that moved the row. */
  applied: boolean;
  /**
   * True when the row now holds the outcome this call asked for — either
   * because this call moved it, or because it was already there.
   *
   * A result belongs on the node whenever the row says that outcome is what
   * happened, and the ingest Worker repeats a report it did not hear a 2xx
   * for. Keying the write on `applied` instead loses the content on exactly
   * the retry that exists to recover it.
   */
  landed: boolean;
  counts: NodeTaskCounts;
}

/** What clearing a record hands back. */
export interface DismissResult {
  /** True when a row was actually hidden. */
  removed: boolean;
  counts: NodeTaskCounts;
}

/**
 * Open a task in `running` on a node.
 * @param opts - Project, space and node it belongs to, who started it, the
 *   conservative allowance, and the label the user reads.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The space, so an event can name the document.
 * @param opts.nodeId - The node this task runs on.
 * @param opts.kind - `upload` or `generation`.
 * @param opts.startedByUserId - Who started it.
 * @param opts.budgetMs - The conservative allowance the timer is set from.
 * @param opts.label - Filename or model name, what the user reads.
 * @param opts.taskId - The AIGC job; absent on uploads.
 * @param opts.storageKey - The upload grant; absent on generations.
 * @returns The new task's id and the node's counts after it.
 */
export async function open(opts: {
  projectId: string;
  spaceId: string;
  nodeId: string;
  kind: "upload" | "generation";
  startedByUserId: string;
  budgetMs: number;
  label: string;
  taskId?: string;
  storageKey?: string;
}): Promise<{ id: string; counts: NodeTaskCounts }> {
  const id = await repo.insertRunning(opts);
  const counts = await repo.countsFor(opts.projectId, opts.nodeId);
  return { id, counts };
}

/**
 * Record a fact about a task: it finished, it failed, or its time ran out.
 *
 * Never throws on a state mismatch. A report that arrives after the row went
 * terminal is late, not wrong, and the caller has other work riding on the
 * same request.
 * @param opts - Which task, where it lands, and the result pointer or reason.
 * @param opts.taskId - Which task.
 * @param opts.outcome - Where it lands.
 * @param opts.nodeHistoryId - The history row holding the result.
 * @param opts.errorMessage - Why it failed or timed out.
 * @returns Whether this call moved the row, plus the node's counts.
 * @throws {Error} When the task id names no row at all — a machine reporting
 *   about a task nobody opened is a wiring fault, not a late message.
 */
export async function settle(opts: {
  taskId: string;
  outcome: Exclude<NodeTaskStatus, "running">;
  nodeHistoryId?: string;
  errorMessage?: string;
}): Promise<SettleResult> {
  const row = await repo.findById(opts.taskId);
  if (row === null) {
    throw new Error(`settle: no node_tasks row for ${opts.taskId}`);
  }

  const applied = await repo.settleRunning(opts.taskId, opts.outcome, {
    ...(opts.nodeHistoryId !== undefined && {
      nodeHistoryId: opts.nodeHistoryId,
    }),
    ...(opts.errorMessage !== undefined && { errorMessage: opts.errorMessage }),
  });

  // The row had already settled and a result turned up anyway: the deadline
  // passed before the report arrived. The status stays put — the user may
  // have retried and picking for them is not ours to do — while the result
  // becomes reachable from the list.
  if (!applied && opts.nodeHistoryId !== undefined) {
    await repo.attachResult(opts.taskId, opts.nodeHistoryId);
  }

  const counts = await repo.countsFor(row.projectId, row.nodeId);
  return { applied, landed: applied || row.status === opts.outcome, counts };
}

/**
 * Clear one record from the list at the user's request.
 * @param opts - Which task.
 * @param opts.taskId - Which task.
 * @param opts.projectId - The caller's project, used to recount when this
 *   table never held the row.
 * @param opts.nodeId - The caller's node, same purpose.
 * @returns Whether a row was hidden, plus the node's counts.
 * @throws {ConflictError} When the row is still running: a task that has not
 *   settled is not a record to clear yet.
 */
export async function dismiss(opts: {
  taskId: string;
  projectId?: string;
  nodeId?: string;
}): Promise<DismissResult> {
  const row = await repo.findById(opts.taskId);

  if (row !== null && row.status === "running") {
    throw new ConflictError(t("canvas.task.stillRunning"));
  }

  const removed =
    row === null ? false : await repo.softDeleteSettled(opts.taskId);

  // The counts come from whichever node we can name: the row when it exists,
  // the caller's own context when the user is clearing something this table
  // never held.
  const projectId = row?.projectId ?? opts.projectId;
  const nodeId = row?.nodeId ?? opts.nodeId;
  const counts =
    projectId !== undefined && nodeId !== undefined
      ? await repo.countsFor(projectId, nodeId)
      : { running: 0, done: 0, failed: 0, expired: 0 };

  return { removed, counts };
}

/**
 * Read one task row, whatever state it is in.
 *
 * The route layer's guard runs on this: the path carries only a task id,
 * which anyone could guess, so the project to check access against comes
 * from the row rather than from the request.
 * @param taskId - Which task.
 * @returns The row, or null when the table does not hold it.
 */
export async function findById(
  taskId: string,
): Promise<(NodeTaskRow & { deletedAt: Date | null }) | null> {
  return repo.findById(taskId);
}

/**
 * Find the task an upload grant belongs to.
 * @param storageKey - The grant the bytes landed under.
 * @returns The row, or null when no task was opened for that key.
 */
export async function findByStorageKey(
  storageKey: string,
): Promise<NodeTaskRow | null> {
  return repo.findByStorageKey(storageKey);
}

/**
 * Read the four numbers the node's corner shows.
 * @param opts - Project and node.
 * @param opts.projectId - Owning project.
 * @param opts.nodeId - The node.
 * @returns One count per state.
 */
export async function countsFor(opts: {
  projectId: string;
  nodeId: string;
}): Promise<NodeTaskCounts> {
  return repo.countsFor(opts.projectId, opts.nodeId);
}

/**
 * List the live tasks on a node, for the panel the user just opened.
 * @param opts - Project and node.
 * @param opts.projectId - Owning project.
 * @param opts.nodeId - The node.
 * @returns Every row the user may still act on, newest first.
 */
export async function listLive(opts: {
  projectId: string;
  nodeId: string;
}): Promise<NodeTaskListRow[]> {
  return repo.listLive(opts.projectId, opts.nodeId);
}
