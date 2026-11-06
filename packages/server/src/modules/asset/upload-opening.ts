// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Opening an upload: the grant, and the row on the node it lands on (#207,
 * design I3).
 *
 * Both lanes that hand bytes to the ingest Worker start here — the browser
 * asking for a ticket, and a caller handing over an address. Each used to do
 * these two steps itself, held in the right order by a comment of its own,
 * and the invariant they were keeping is that every grant naming a node has
 * exactly one row in `node_tasks` carrying that grant's storage key.
 *
 * Breaking it is silent. Settlement finds the row by the key off the grant and
 * by nothing else: a row opened before the grant has no key to be found by, a
 * row opened on a different key is never found, and either way the node shows
 * a task that runs until a harvest calls it expired.
 *
 * Which node the row goes on is read off the grant's own context rather than
 * taken a second time, so the two cannot name different places. A 3D model
 * upload names a Space and no node, and its row joins that Space's own task
 * list (inner#1690).
 */

import { accountActivityRepo, db } from "@breatic/core";
import { canvasSpaceDocName, type NodeTaskAction } from "@breatic/shared";
import { nodeTaskService, sceneTaskService, uploadGrantService } from "@breatic/domain";
import { publishCountsQuietly, publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";

/** What `issueUploadGrant` takes, so a lane passes its own through unchanged. */
type GrantInput = Parameters<typeof uploadGrantService.issueUploadGrant>[0];

/** What the caller decides about the row, when there is a row. */
interface TaskRowRequest {
  /**
   * How long this upload may run before a reader judges it dead.
   *
   * Each caller supplies the common node-task budget from
   * getNodeTaskConfig().default_budget_ms.
   */
  budgetMs: number;
  /** What the row's first line names. */
  action: NodeTaskAction;
  /** What the node's task list shows — a filename, the address, or a tool id. */
  label: string;
}

/** An opened upload: where the bytes go, and the row watching for them. */
export interface OpenedUpload {
  /** The storage key, which the grant and the row both carry. */
  key: string;
  /** The studio the bytes are charged to. */
  studioId: string;
  /** The row's id, absent when the grant named no node. */
  taskId: string | undefined;
}

/**
 * Open the grant and the row, for a lane whose caller always names a node.
 *
 * Its row's id is what that lane answers with, so it is a string rather than
 * something the route has to handle the absence of.
 * @param grant - What the lane asks the grant for, naming node and space.
 * @param task - The budget and the label for the row.
 * @param recordUserAction - Explicit user admission; transport-only uploads omit it.
 * @returns The key, the studio, and the row's id.
 */
export async function openUpload(
  grant: GrantInput & {
    projectId: string;
    context: { nodeId: string; spaceId: string };
  },
  task: TaskRowRequest,
  recordUserAction?: boolean,
): Promise<OpenedUpload & { taskId: string }>;

/**
 * Open the grant, and the row when the grant names somewhere to put one.
 * @param grant - What the lane asks the grant for, passed through untouched.
 * @param task - The budget and the label for the row, when one is opened.
 * @param recordUserAction - Explicit user admission; transport-only uploads omit it.
 * @returns The key, the studio, and the row's id when there is a row.
 */
export async function openUpload(
  grant: GrantInput,
  task: TaskRowRequest,
  recordUserAction?: boolean,
): Promise<OpenedUpload>;

/**
 * Open the grant, then the row on whatever node the grant named.
 *
 * An upload with no node behind it — a focus crop, a project cover, a studio
 * avatar — opens the grant alone: the counts live in a node's corner, and
 * there is no corner. Both halves of where
 * a row would go have to be present, because the space is what names the
 * document the counts are published on.
 * @param grant - What the lane asks the grant for, passed through untouched.
 * @param task - The budget and the label for the row, when one is opened.
 * @param recordUserAction - Explicit user admission; transport-only uploads omit it.
 * @returns The key, the studio, and the row's id when there is a row.
 * @throws {Error} When grant, activity or node-row persistence fails; their
 *   shared product transaction rolls back.
 */
export async function openUpload(
  grant: GrantInput,
  task: TaskRowRequest,
  recordUserAction?: boolean,
): Promise<OpenedUpload> {
  const admitted = await db.transaction(async (tx) => {
    const { key, studioId } = await uploadGrantService.issueUploadGrant(grant, tx);
    const { nodeId, spaceId } = grant.context;
    const { projectId } = grant;
    if (recordUserAction) {
      await accountActivityRepo.recordActivity({ userId: grant.actingUserId, projectId: projectId ?? null, kind: "project_action" }, tx);
    }
    if (task.action === "scene_import" && projectId !== undefined && spaceId != null) {
      const sceneTaskId = await sceneTaskService.open({
        projectId, spaceId, startedByUserId: grant.actingUserId,
        budgetMs: task.budgetMs, label: task.label, storageKey: key,
      }, tx);
      return { key, studioId, taskId: sceneTaskId, sceneSpace: { projectId, spaceId } };
    }
    if (projectId === undefined || nodeId == null || spaceId == null) {
      return { key, studioId, taskId: undefined };
    }
    const opened = await nodeTaskService.open({
      projectId, spaceId, nodeId, kind: "upload", action: task.action,
      startedByUserId: grant.actingUserId, budgetMs: task.budgetMs,
      label: task.label, storageKey: key,
    }, tx);
    return { key, studioId, taskId: opened.id, counts: opened.counts, nodeId, spaceId, projectId };
  });
  if ("sceneSpace" in admitted && admitted.sceneSpace) {
    await publishSpaceTasksQuietly(admitted.sceneSpace.projectId, admitted.sceneSpace.spaceId);
  }
  if ("counts" in admitted && admitted.counts) {
    await publishCountsQuietly(canvasSpaceDocName(admitted.projectId, admitted.spaceId), admitted.nodeId, admitted.counts);
  }
  return { key: admitted.key, studioId: admitted.studioId, taskId: admitted.taskId };
}
