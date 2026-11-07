// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `tasks` queue the 3D Space's services queue and inspect jobs on,
 * opened on first use: a module that opens it at import needs the core
 * configuration before anything that merely imports it has set it up.
 */

import { createQueue } from "@breatic/core";

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * The `tasks` queue, opened once.
 * @returns The queue.
 * @throws {Error} When the queue's Redis configuration cannot be read.
 */
export function tasksQueue(): ReturnType<typeof createQueue> {
  queue ??= createQueue("tasks");
  return queue;
}
