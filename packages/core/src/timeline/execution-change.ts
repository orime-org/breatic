// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one way to say an execution row changed (#1490 design §4.7), called after every write to it: the server's accept
 * and cancel, the worker's transitions, retry claims and step records. A Motion Space's execution goes onto the
 * task-events stream, from which collab writes the change into the Space's own document; every open tab of the Space
 * watches that document and reads its lists again.
 */

import { webAnimationSpaceDocName, type SpaceTasksVersionEvent, type TimelineExecution } from "@breatic/shared";
import { publishSpaceTasksChanged } from "@core/infra/control-events.js";
import { publishToStream, taskEventsStreamKey } from "@core/infra/event-stream.js";
import { getStreamRedis } from "@core/infra/redis.js";

/**
 * Announce that an execution changed, to the Space it belongs to.
 * @param row - The execution.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceExecutionChange(row: Pick<TimelineExecution, "projectId" | "spaceId" | "origin">): Promise<void> {
  if (row.origin !== "web_animation_space") {
    await publishSpaceTasksChanged(row.projectId, row.spaceId);
    return;
  }
  const event: SpaceTasksVersionEvent = { type: "space-tasks-version", docName: webAnimationSpaceDocName(row.projectId, row.spaceId) };
  await publishToStream(getStreamRedis(), taskEventsStreamKey(), { ...event });
}
