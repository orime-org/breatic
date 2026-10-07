// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /mini-tools` — the one entry every server-run mini-tool shares
 * (inner#888 §6.1). The body is validated against the registry, the run is
 * prepared, and the result nodes' rows open before the credit gate so a
 * refusal has somewhere to be said. Browser tools never come here: their
 * export uploads like any other file.
 */

import { Hono } from "hono";
import { AppError, createQueue, defaultJobOpts, logger } from "@breatic/core";
import { taskService } from "@breatic/domain";
import { miniToolById, miniToolRequestSchema, type TaskFailureReason } from "@breatic/shared";

import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { precheckCredits, projectService } from "@server/modules";
import { prepareRun } from "@server/modules/mini-tool/mini-tool.service.js";
import { failOpenedTasks, openGenerationTasks } from "@server/modules/task/generation-task.js";

const miniTools = new Hono<{ Variables: AuthVariables }>();

miniTools.use("*", requireAuth);

const tasksQueue = createQueue("tasks");

/**
 * Run one mini-tool onto the result nodes the browser built.
 * @param c - Hono context with the validated request.
 * @returns `201` with `{ task_id, status }` — `"pending"` once queued,
 * `"failed"` when the run was refused after its rows opened (the rows hold
 * the cause).
 * @throws {AppError} The refusal itself, when no row was opened to carry it.
 */
miniTools.post("/", rateLimitFor("mini_tool", "user"), validate("json", miniToolRequestSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const spec = miniToolById(body.tool)!;

  await projectService.assertAccess(body.project_id, user.id, "editor");
  const run = await prepareRun(spec, body);

  const taskType = spec.outputs[0]!.modality;
  const task = await taskService.create(
    user.id,
    body.project_id,
    body.space_id,
    taskType,
    "append",
    run.params,
    run.model,
    undefined,
    "mini_tool",
  );

  let rows: Awaited<ReturnType<typeof openGenerationTasks>> = [];
  try {
    rows = await openGenerationTasks({
      projectId: body.project_id,
      spaceId: body.space_id,
      nodeIds: body.node_ids,
      startedByUserId: user.id,
      taskId: task.id,
      action: "mini_tool",
      label: spec.id,
    });

    await precheckCredits(body.project_id, user.id, run.credits);

    const job = await tasksQueue.add(
      "execute-mini-tool",
      {
        taskId: task.id,
        userId: user.id,
        projectId: body.project_id,
        spaceId: body.space_id,
        source: "mini_tool",
        toolId: spec.id,
        taskType,
        params: run.params,
        ...(run.sourceKey !== undefined && { sourceKey: run.sourceKey }),
        targetNodeIds: body.node_ids,
        mode: "append" as const,
      },
      defaultJobOpts(),
    );

    // Past the point of no return: the job runs whether or not its id is kept.
    try {
      await taskService.setJobId(task.id, job.id ?? "");
    } catch (err) {
      logger.error({ err, taskId: task.id, jobId: job.id, projectId: body.project_id }, "mini_tool_job_id_not_recorded");
    }
  } catch (err) {
    const reason: TaskFailureReason =
      err instanceof AppError && err.statusCode === 402 ? "no_credits" : "internal";
    for (const settle of [
      (): Promise<unknown> => taskService.markFailed(task.id, reason),
      (): Promise<unknown> => failOpenedTasks(body.project_id, body.space_id, rows, reason),
    ]) {
      try {
        await settle();
      } catch (settleErr) {
        logger.error({ err: settleErr, taskId: task.id, projectId: body.project_id }, "mini_tool_run_settle_failed");
      }
    }
    logger.warn({ err, taskId: task.id, projectId: body.project_id, tool: spec.id, reason }, "mini_tool_run_failed");
    if (rows.length > 0) {
      return c.json({ data: { task_id: task.id, status: "failed" } }, 201);
    }
    throw err;
  }

  return c.json({ data: { task_id: task.id, status: "pending" } }, 201);
});

export { miniTools as miniToolsRoute };
