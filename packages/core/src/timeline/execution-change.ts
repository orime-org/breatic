// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one way to say an execution row changed (#1490 design §4.7), called after every write the user can see: the
 * server's accept and cancel and the worker's transitions. The change goes onto the task-events stream, from which
 * collab writes it into the document of the Space the execution belongs to (a Motion Space, or the Timeline an older
 * execution was made in) and into the Timelines of every Project holding a grant to it, where a placeholder can wait
 * for its result; every open tab of those Spaces watches its document and reads its lists again.
 */

import { timelineSpaceDocName, webAnimationSpaceDocName, type SpaceTasksVersionEvent, type TimelineExecution } from "@breatic/shared";
import { publishToStream, taskEventsStreamKey } from "@core/infra/event-stream.js";
import { getStreamRedis } from "@core/infra/redis.js";
import { grantedProjectIds } from "@core/timeline/execution-grant.repo.js";

/**
 * Announce that an execution changed, to the Space it belongs to and the Timelines of every Project granted it.
 * @param row - The execution.
 * @returns Nothing.
 * @throws {Error} When reading its grants fails or Redis rejects the publish.
 */
export async function announceExecutionChange(row: Pick<TimelineExecution, "id" | "projectId" | "spaceId" | "origin">): Promise<void> {
  const docNameOf = row.origin === "timeline" ? timelineSpaceDocName : webAnimationSpaceDocName;
  const event: SpaceTasksVersionEvent = {
    type: "space-tasks-version", docName: docNameOf(row.projectId, row.spaceId), projects: await grantedProjectIds(row.id),
  };
  await publishToStream(getStreamRedis(), taskEventsStreamKey(), { ...event });
}
