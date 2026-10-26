// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { getStreamRedis } from "@breatic/core";
import type { MiniToolExecution, MiniToolExecutionCompletion } from "@breatic/domain";

/**
 * Commit indexed execution media before restoring history and original target notifications.
 * @param _taskId - The original accepted task.
 * @param _completion - The complete indexed observation and call-set proof.
 * @param _streamRedis - The application's task-event stream connection.
 * @returns The committed execution and its SQL-owned notification destination.
 * @throws {Error} Until the common completion boundary is implemented.
 */
export async function finishMiniToolExecutionAndNotify(_taskId: string, _completion: MiniToolExecutionCompletion, _streamRedis: ReturnType<typeof getStreamRedis>): Promise<MiniToolExecution> {
  throw new Error("Planned execution notification is not implemented");
}
