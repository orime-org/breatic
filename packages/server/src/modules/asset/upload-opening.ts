// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * taken a second time, so the two cannot name different places.
 */

import { canvasSpaceDocName } from "@breatic/shared";
import { nodeTaskService, uploadGrantService } from "@breatic/domain";
import { publishCountsQuietly } from "@server/modules/task/publish-counts.js";

/** What `issueUploadGrant` takes, so a lane passes its own through unchanged. */
type GrantInput = Parameters<typeof uploadGrantService.issueUploadGrant>[0];

/** What the caller decides about the row, when there is a row. */
interface TaskRowRequest {
  /**
   * How long this upload may run before a reader judges it dead.
   *
   * Named by the lane rather than read here: the browser's is sized for a
   * person who may genuinely still be uploading, while the lane that takes an
   * address is bounded by one call the configuration ends in minutes.
   */
  budgetMs: number;
  /** What the node's task list shows — a filename, or the address. */
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
 * @returns The key, the studio, and the row's id.
 */
export async function openUpload(
  grant: GrantInput & { context: { nodeId: string; spaceId: string } },
  task: TaskRowRequest,
): Promise<OpenedUpload & { taskId: string }>;

/**
 * Open the grant, and the row when the grant names somewhere to put one.
 * @param grant - What the lane asks the grant for, passed through untouched.
 * @param task - The budget and the label for the row, when one is opened.
 * @returns The key, the studio, and the row's id when there is a row.
 */
export async function openUpload(
  grant: GrantInput,
  task: TaskRowRequest,
): Promise<OpenedUpload>;

/**
 * Open the grant, then the row on whatever node the grant named.
 *
 * An upload with no node behind it — a focus crop — opens the grant alone: the
 * counts live in a node's corner, and there is no corner. Both halves of where
 * a row would go have to be present, because the space is what names the
 * document the counts are published on.
 * @param grant - What the lane asks the grant for, passed through untouched.
 * @param task - The budget and the label for the row, when one is opened.
 * @returns The key, the studio, and the row's id when there is a row.
 * @throws {Error} Whatever issuing the grant or opening the row throws; a lane
 *   that has to settle the grant on a failed row does that itself.
 */
export async function openUpload(
  grant: GrantInput,
  task: TaskRowRequest,
): Promise<OpenedUpload> {
  const { key, studioId } = await uploadGrantService.issueUploadGrant(grant);

  const { nodeId, spaceId } = grant.context;
  if (
    nodeId === undefined ||
    nodeId === null ||
    spaceId === undefined ||
    spaceId === null
  ) {
    return { key, studioId, taskId: undefined };
  }

  const opened = await nodeTaskService.open({
    projectId: grant.projectId,
    spaceId,
    nodeId,
    kind: "upload",
    startedByUserId: grant.actingUserId,
    budgetMs: task.budgetMs,
    label: task.label,
    storageKey: key,
  });
  await publishCountsQuietly(
    canvasSpaceDocName(grant.projectId, spaceId),
    nodeId,
    opened.counts,
  );

  return { key, studioId, taskId: opened.id };
}
