// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one way to say an execution row changed (#1568, #1490 design §4.7), called after every write the user can see:
 * the server's accept and cancel, the running-task gate's claim and first wait, and the worker's transitions. The change
 * goes onto the task-events stream, from which collab writes it into the document of the Space the execution belongs to:
 * a Motion Space, or the Timeline an older execution was made in. Every open tab of that Space watches its document and
 * reads its lists again.
 */

import { timelineSpaceDocName, webAnimationSpaceDocName, type TimelineExecution } from "@breatic/shared";
import { announceSpaceTasksVersion } from "@core/infra/space-tasks-version.js";

/**
 * Announce that an execution changed, to the Space it belongs to.
 * @param row - The execution.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceExecutionChange(row: Pick<TimelineExecution, "projectId" | "spaceId" | "origin">): Promise<void> {
  const docNameOf = row.origin === "timeline" ? timelineSpaceDocName : webAnimationSpaceDocName;
  await announceSpaceTasksVersion(docNameOf(row.projectId, row.spaceId));
}
