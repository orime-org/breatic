// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one way to say a Space's task rows changed (root `AGENTS.md#space-task-state-lives-in-the-space-document`):
 * the change goes onto the task-events stream, collab writes its stream id into that Space's document, and every open
 * tab of the Space reads its lists again.
 */

import { threeDSpaceDocName, type SpaceTasksVersionEvent } from "@breatic/shared";
import { publishToStream, taskEventsStreamKey } from "@core/infra/event-stream.js";
import { getStreamRedis } from "@core/infra/redis.js";

/**
 * Announce that the task rows of the Space with this document changed.
 * @param docName - The Space's document; its type must be in `SPACE_TASKS_TYPES`.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceSpaceTasksChange(docName: string): Promise<void> {
  const event: SpaceTasksVersionEvent = { type: "space-tasks-version", docName };
  await publishToStream(getStreamRedis(), taskEventsStreamKey(), { ...event });
}

/**
 * Announce that a 3D Space's own task rows changed.
 * @param at - Where the rows are.
 * @param at.projectId - The Project.
 * @param at.spaceId - The 3D Space.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceSceneTasksChange(at: { projectId: string; spaceId: string }): Promise<void> {
  await announceSpaceTasksChange(threeDSpaceDocName(at.projectId, at.spaceId));
}
