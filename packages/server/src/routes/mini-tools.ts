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
import { createQueue, defaultJobOpts } from "@breatic/core";
import { taskService } from "@breatic/domain";
import { miniToolById, miniToolRequestSchema } from "@breatic/shared/mini-tools";

import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { projectService } from "@server/modules";
import { prepareRun } from "@server/modules/mini-tool/mini-tool.service.js";
import { startRowedRun } from "@server/modules/task/generation-task.js";

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
    "mini_tool",
  );

  const status = await startRowedRun({
    taskId: task.id,
    projectId: body.project_id,
    spaceId: body.space_id,
    nodeIds: body.node_ids,
    userId: user.id,
    action: "mini_tool",
    label: spec.id,
    credits: () => Promise.resolve(run.credits),
    enqueue: () =>
      tasksQueue.add(
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
      ),
    logTag: "mini_tool",
    logContext: { tool: spec.id },
  });
  return c.json({ data: { task_id: task.id, status } }, 201);
});

export { miniTools as miniToolsRoute };
