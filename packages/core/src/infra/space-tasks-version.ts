// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one way to say a Space's background work changed (root `AGENTS.md#space-task-state-lives-in-the-space-document`):
 * the change goes onto the task-events stream, from which collab writes its stream id into that Space's document, and
 * every open tab of the Space watches the document and reads its lists again. Callers name the document, so a 3D
 * Space's rows and a Timeline's executions announce through the same entry.
 */

import type { SpaceTasksVersionEvent } from "@breatic/shared";
import { publishToStream, taskEventsStreamKey } from "@core/infra/event-stream.js";
import { getStreamRedis } from "@core/infra/redis.js";

/**
 * Announce that the background work of the Space behind `docName` changed.
 * @param docName - The Space's document.
 * @returns Nothing.
 * @throws {Error} When Redis rejects the publish.
 */
export async function announceSpaceTasksVersion(docName: string): Promise<void> {
  const event: SpaceTasksVersionEvent = { type: "space-tasks-version", docName };
  await publishToStream(getStreamRedis(), taskEventsStreamKey(), { ...event });
}
