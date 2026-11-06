// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lifecycle of a 3D Space's own task rows (inner#1690).
 *
 * A model upload opens a row with no node: the Space's task list is where
 * every member sees it, and where a finished one is placed into the scene
 * from. The rows share `node_tasks` and its state rule with the Canvas rows,
 * so a row still moves out of `running` exactly once, through
 * `settleRunning` or the harvest; what differs is that the result is the
 * registered asset, and that a row holding a model is never removed.
 */

import type { DbTx } from "@breatic/core";
import * as repo from "@domain/node-task/node-task.repo.js";
import { failureOutcome } from "@domain/node-task/failure-outcome.js";
import type { NodeTaskRow } from "@domain/node-task/node-task.repo.js";

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
  outcome: { outcome: "done"; assetId: string } | { outcome: "failed"; errorMessage: string },
): Promise<SceneSettleResult> {
  if (outcome.outcome === "done") {
    const applied = await repo.settleRunning(row.id, "done", { assetId: outcome.assetId });
    const assetWritten = applied || (await repo.attachAsset(row.id, outcome.assetId));
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
): Promise<{ tasks: NodeTaskRow[]; harvested: number }> {
  const harvested = await repo.harvestExpiredInSpace(projectId, spaceId);
  const tasks = await repo.listSpace(projectId, spaceId);
  return { tasks, harvested };
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
 * Find the row an upload grant opened.
 * @param storageKey - The grant's key.
 * @returns The row when it is a Space-level row, otherwise null.
 */
export async function findByStorageKey(storageKey: string): Promise<NodeTaskRow | null> {
  const row = await repo.findByStorageKey(storageKey);
  return row !== null && row.nodeId === null ? row : null;
}
