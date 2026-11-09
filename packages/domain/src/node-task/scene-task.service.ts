// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lifecycle of a 3D Space's own task rows (inner#1690, inner#1691).
 *
 * A model upload or a 3D generation opens a row with no node: the Space's task list is where
 * every member sees it, and where a finished one is placed into the scene
 * from. The rows share `node_tasks` and its state rule with the Canvas rows,
 * so a row still moves out of `running` exactly once, through
 * `settleRunning` or the harvest; what differs is that the result is the
 * registered asset, and that a row holding a model is never removed.
 */

import type { DbTx } from "@breatic/core";
import { SCENE_TASK_NOTICES, type SceneGenerationOrigin, type SceneTaskNotice, type TaskEntity, type TaskFailureReason } from "@breatic/shared";
import { findLiveTasksByIds } from "@domain/task/task.repo.js";
import * as repo from "@domain/node-task/node-task.repo.js";
import { failureOutcome } from "@domain/node-task/failure-outcome.js";
import type { NodeTaskRow, SceneTaskRow } from "@domain/node-task/node-task.repo.js";

/** Where one settle left a Space-level row. */
export interface SceneSettleResult {
  /** The row as it stood before this settle. */
  row: NodeTaskRow;
  /** Whether this call moved the row out of `running`. */
  applied: boolean;
  /**
   * Whether this call wrote the row's asset: the one moment a model upload
   * becomes usable, so the one moment its activity is written.
   */
  assetWritten: boolean;
}

/**
 * Open a running row for a model upload.
 * @param opts - The row.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The 3D Space.
 * @param opts.startedByUserId - Who uploads.
 * @param opts.budgetMs - The task budget.
 * @param opts.label - The model name the user gave.
 * @param opts.storageKey - The upload grant.
 * @param tx - The transaction the grant is written in.
 * @returns The row's id.
 */
export async function open(opts: {
  projectId: string;
  spaceId: string;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  storageKey: string;
}, tx?: DbTx): Promise<string> {
  return repo.insertSceneRow(opts, tx);
}

/**
 * Open a row already holding the model a dedup hit matched.
 * @param opts - The row.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The 3D Space.
 * @param opts.startedByUserId - Who imported.
 * @param opts.label - The model name the user gave.
 * @param opts.assetId - The matched asset.
 * @returns The row's id.
 */
export async function openDone(opts: {
  projectId: string;
  spaceId: string;
  startedByUserId: string;
  label: string;
  assetId: string;
}): Promise<string> {
  return repo.insertSceneRow({ ...opts, budgetMs: 0 });
}

/**
 * Open a running row for a 3D generation (inner#1691), before its job is
 * queued: the job names this row, and the worker settles it.
 * @param opts - The row.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The 3D Space it was submitted in.
 * @param opts.startedByUserId - Who submitted it.
 * @param opts.budgetMs - The task budget.
 * @param opts.label - The cleaned prompt, the front image's name or the model's.
 * @param opts.taskId - The AIGC job.
 * @param opts.origin - The Space's own dialog, or an agent proposal.
 * @returns The row's id.
 */
export async function openGeneration(opts: {
  projectId: string;
  spaceId: string;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  taskId: string;
  origin: SceneGenerationOrigin;
}): Promise<string> {
  return repo.insertSceneGenerationRow(opts);
}

/**
 * How a row ends: done with its model and what the user is told beside it,
 * or failed with a `task-failure` code.
 */
export type SceneOutcome =
  | { outcome: "done"; assetId: string; notice: SceneTaskNotice | null }
  | { outcome: "failed"; errorMessage: string };

/**
 * How a 3D generation's row ends from what its run stored (inner#1691): done
 * with the registered model, or `no_result` when the run came back with none.
 * The notice is read from the stored result too (inner#1692), so every path
 * that settles from it (the live run, a billed redelivery, the crash net, the
 * server's check) tells the user the same thing.
 * @param result - The run's stored result: its persisted outputs (the catalog lane writes one) and the notice.
 * @returns The outcome the row settles with.
 */
export function generationOutcome(
  result: { readonly outputs?: readonly { asset_id?: unknown }[]; readonly notice?: unknown } | null | undefined,
): SceneOutcome {
  // ponytail: the first output is the model, as the catalog lane returns it;
  // a vendor listing the GLB elsewhere needs a model-level output index (design H4).
  const assetId = result?.outputs?.[0]?.asset_id;
  if (typeof assetId !== "string") return { outcome: "failed", errorMessage: "no_result" satisfies TaskFailureReason };
  const notice = SCENE_TASK_NOTICES.find((known) => known === result?.notice) ?? null;
  return { outcome: "done", assetId, notice };
}

/**
 * Settle the row with this id ({@link settle}).
 * @param rowId - The row.
 * @param outcome - What happened.
 * @returns Where the row stands, or null when there is no such row.
 */
export async function settleById(rowId: string, outcome: SceneOutcome): Promise<SceneSettleResult | null> {
  const row = await repo.findSceneRow(rowId);
  return row === null ? null : settle(row, outcome);
}

/**
 * Record how a model upload ended.
 *
 * A success that finds the row already expired still lands its model there
 * when the row is unremoved and empty; a failure at or past the deadline
 * lands as `expired`, the way the harvest writes it.
 * @param row - The row, read by the caller.
 * @param outcome - What happened.
 * @param outcome.outcome - `done` or `failed`.
 * @param outcome.assetId - The registered model, on success.
 * @param outcome.errorMessage - Why, on failure.
 * @returns Where the row stands.
 */
export async function settle(
  row: NodeTaskRow,
  outcome: SceneOutcome,
): Promise<SceneSettleResult> {
  if (outcome.outcome === "done") {
    const applied = await repo.settleRunning(row.id, "done", { assetId: outcome.assetId, notice: outcome.notice });
    const assetWritten = applied || (await repo.attachAsset(row.id, outcome.assetId, outcome.notice));
    return { row, applied, assetWritten };
  }
  const expired = failureOutcome(row.startedAt.getTime() + row.budgetMs) === "expired";
  const applied = await repo.settleRunning(row.id, expired ? "expired" : "failed", {
    errorMessage: expired ? "expired" : outcome.errorMessage,
  });
  return { row, applied, assetWritten: false };
}

/**
 * Read a Space's list, judging overdue rows dead first.
 * @param projectId - Owning project.
 * @param spaceId - The Space.
 * @returns The rows, newest first, and how many this read expired.
 */
export async function harvestAndList(
  projectId: string,
  spaceId: string,
): Promise<{ tasks: SceneTaskRow[]; harvested: number }> {
  const harvested = await repo.harvestExpiredInSpace(projectId, spaceId);
  const tasks = await repo.listSpace(projectId, spaceId);
  return { tasks, harvested };
}

/**
 * The runs behind a list's generation rows (inner#1691), which hold what each
 * was asked for: the model and the job's params.
 * @param rows - The rows a list read.
 * @returns Each generation row's run, by task id.
 */
export async function runsOf(rows: readonly SceneTaskRow[]): Promise<Map<string, TaskEntity>> {
  const ids = rows.flatMap((row) => (row.action === "generate" && row.taskId !== null ? [row.taskId] : []));
  return new Map((await findLiveTasksByIds(ids)).map((task) => [task.id, task]));
}

/**
 * Hide a failed row, or an expired one holding no model, at a user's request.
 * @param taskId - Which row.
 * @returns True when it was hidden; false when the row may not be removed.
 */
export async function remove(taskId: string): Promise<boolean> {
  return repo.softDeleteSceneTask(taskId);
}

/**
 * Read a Space-level row by id, whatever state it is in.
 * @param taskId - Which row.
 * @returns The row, or null when no row without a node has that id.
 */
export async function findById(taskId: string): Promise<(SceneTaskRow & { deletedAt: Date | null }) | null> {
  return repo.findSceneRow(taskId);
}

/**
 * Find the row an upload grant opened.
 * @param storageKey - The grant's key.
 * @returns The row when it is a Space-level row, otherwise null.
 */
export async function findByStorageKey(storageKey: string): Promise<NodeTaskRow | null> {
  const row = await repo.findByStorageKey(storageKey);
  return row !== null && row.nodeId === null ? row : null;
}
