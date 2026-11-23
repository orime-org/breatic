// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one way to say a Timeline execution row changed (#1568), called after every write the user can see: the server's
 * cancel, collab's landing and the worker's transitions. The change goes onto the task-events stream, from which collab
 * writes it into the document of the Timeline the execution belongs to; every open tab of that Timeline watches its
 * document and reads its lists again.
 */

import { timelineSpaceDocName, type SpaceTasksVersionEvent, type TimelineExecution } from "@breatic/shared";
import { publishToStream, taskEventsStreamKey } from "@core/infra/event-stream.js";
import { getStreamRedis } from "@core/infra/redis.js";

/**
 * Announce that an execution changed, to the Timeline it belongs to.
 * @param row - The execution.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceExecutionChange(row: Pick<TimelineExecution, "projectId" | "spaceId">): Promise<void> {
  const event: SpaceTasksVersionEvent = { type: "space-tasks-version", docName: timelineSpaceDocName(row.projectId, row.spaceId) };
  await publishToStream(getStreamRedis(), taskEventsStreamKey(), { ...event });
}
