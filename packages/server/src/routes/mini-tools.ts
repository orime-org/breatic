// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `POST /mini-tools` — the one entry every server-run mini-tool shares
 * (inner#888 §6.1). The body is validated against the registry, the run is
 * prepared, and its estimate is held before the task row and the result
 * nodes' rows are written, so a refusal by credits or a spend limit answers
 * 402 and leaves nothing on the nodes (inner#1968). Browser tools never come
 * here: their
 * export uploads like any other file.
 */

import { randomUUID } from "node:crypto";
import { tasksQueue } from "@server/modules/task/tasks-queue.js";
import { admitGeneration } from "@server/modules/task/admit-generation.service.js";
import { currentConsent } from "@breatic/core";
import { Hono } from "hono";
import { defaultJobOpts } from "@breatic/core";
import { miniToolById, miniToolRequestSchema, outputTemplateOf } from "@breatic/shared/mini-tools";

import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { runOnce } from "@server/middleware/run-once.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";
import { projectService } from "@server/modules";
import { prepareRun } from "@server/modules/mini-tool/mini-tool.service.js";
import { holdRowedRun, startRowedRun } from "@server/modules/task/generation-task.js";

const miniTools = new Hono<{ Variables: AuthVariables }>();

miniTools.use("*", requireAuth);


/**
 * Run one mini-tool onto the result nodes the browser built.
 * @param c - Hono context with the validated request.
 * @returns `201` with `{ task_id, status }` — `"pending"` once queued,
 * `"failed"` when it failed after its rows opened (the rows hold
 * the cause).
 * @throws {AppError} 402 when credits or a spend limit refuse it, before any row opens; any other failure before a row opened.
 */
miniTools.post(
  "/",
  rateLimitFor("mini_tool", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", miniToolRequestSchema),
  runOnce("mini-tool"),
  async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const spec = miniToolById(body.tool)!;

  await projectService.assertAccess(body.project_id, user.id, "editor");
  const run = await prepareRun(spec, body);

  const taskType = outputTemplateOf(spec).modality;
  // Its estimate is held under the id its task takes before any row opens,
  // so a refusal leaves nothing on the nodes (inner#1968).
  const taskId = randomUUID();
  const task = await holdRowedRun({
    taskId,
    projectId: body.project_id,
    userId: user.id,
    credits: () => Promise.resolve(run.credits),
    create: () => admitGeneration(user.id, body.project_id, body.space_id, taskType, "append", run.params, run.model, "mini_tool", taskId),
  });

  const status = await startRowedRun({
    taskId: task.id,
    projectId: body.project_id,
    spaceId: body.space_id,
    nodeIds: body.node_ids,
    userId: user.id,
    action: "mini_tool",
    label: spec.id,
    enqueue: () =>
      tasksQueue().add(
        "execute-mini-tool",
        {
          taskId: task.id,
          userId: user.id,
          // The requesting browser's choice; the worker has no cookie (inner#1442 §4.4.5).
          analyticsConsent: currentConsent(),
          projectId: body.project_id,
          spaceId: body.space_id,
          source: "mini_tool",
          toolId: spec.id,
          taskType,
          params: run.params,
          ...(run.sourceKey !== undefined && { sourceKey: run.sourceKey }),
          // A join's clips after its source, in the order the user set (inner#1825 §6.4).
          ...(run.inputKeys !== undefined && run.inputKeys.length > 1 && { extraKeys: run.inputKeys.slice(1) }),
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
