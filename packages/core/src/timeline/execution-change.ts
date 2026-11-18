// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one way to say an execution row changed (#1490 design §4.7), called after every write the user can see: the
 * server's accept and cancel and the worker's transitions. The change goes onto the task-events stream, from which
 * collab writes it into the document of the Space the execution belongs to (a Motion Space, or the Timeline an older
 * execution was made in); every open tab of that Space watches its document and reads its lists again.
 */

import { timelineSpaceDocName, webAnimationSpaceDocName, type SpaceTasksVersionEvent, type TimelineExecution } from "@breatic/shared";
import { publishToStream, taskEventsStreamKey } from "@core/infra/event-stream.js";
import { getStreamRedis } from "@core/infra/redis.js";

/**
 * Announce that an execution changed, to the Space it belongs to.
 * @param row - The execution.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceExecutionChange(row: Pick<TimelineExecution, "projectId" | "spaceId" | "origin">): Promise<void> {
  const docNameOf = row.origin === "timeline" ? timelineSpaceDocName : webAnimationSpaceDocName;
  const event: SpaceTasksVersionEvent = { type: "space-tasks-version", docName: docNameOf(row.projectId, row.spaceId) };
  await publishToStream(getStreamRedis(), taskEventsStreamKey(), { ...event });
}
