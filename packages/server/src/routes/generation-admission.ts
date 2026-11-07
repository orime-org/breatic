// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The admission a Canvas generation and a 3D Space generation share, up to
 * the hold (inner#1691 design 4.2 steps 1 to 5).
 */

import { randomUUID } from "node:crypto";
import { projectService, reserveForRun } from "@server/modules";

/**
 * Admit a generation up to its hold, the first steps a Canvas generation and a
 * 3D Space generation share (inner#1691 design 4.2 steps 1 to 5): the caller
 * may edit the project, the submission passes the caller's checks, and the
 * estimate is held under the id its task row will carry, before that row
 * exists, so a refusal leaves nothing behind. From here until the job is
 * queued, every way out releases the hold; once queued, the worker charges or
 * releases it.
 * @param opts - The submission.
 * @param opts.projectId - The project it runs in.
 * @param opts.userId - Who submits it.
 * @param opts.check - The submission's own checks; throws its refusal, returns what the estimate reads.
 * @param opts.credits - The run's estimate, from what the checks returned.
 * @returns The new task id, and what the checks returned.
 * @throws {AppError} 403 or 404 without editor access, the checks' refusal, 402 when the studio cannot cover the estimate.
 */
export async function holdRun<T>(opts: {
  projectId: string;
  userId: string;
  check: () => Promise<T>;
  credits: (checked: T) => Promise<number>;
}): Promise<{ taskId: string; checked: T }> {
  await projectService.assertAccess(opts.projectId, opts.userId, "editor");
  const checked = await opts.check();
  const taskId = randomUUID();
  await reserveForRun(opts.projectId, opts.userId, taskId, await opts.credits(checked));
  return { taskId, checked };
}
