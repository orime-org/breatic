// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `POST /mini-tools` — the one entry every server-run mini-tool shares
 * (inner#888 §6.1). The body is validated against the registry, the run is
 * prepared, and the result nodes' rows open before the credit gate so a
 * refusal has somewhere to be said. Browser tools never come here: their
 * export uploads like any other file.
 */

import { tasksQueue } from "@server/modules/task/tasks-queue.js";
import { admitGeneration } from "@server/modules/task/admit-generation.service.js";
import { ConflictError, currentConsent, logger } from "@breatic/core";
import { Hono } from "hono";
import { defaultJobOpts } from "@breatic/core";
import { acceptMiniToolExecution, quoteMiniToolExecution } from "@breatic/domain";
import { miniToolById, miniToolPlannedRequestSchema, miniToolSubmissionSchema, outputTemplateOf } from "@breatic/shared/mini-tools";

import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { runOnce } from "@server/middleware/run-once.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";
import { miniToolPlannedRunService, projectService } from "@server/modules";
import { prepareRun } from "@server/modules/mini-tool/mini-tool.service.js";
import { startRowedRun } from "@server/modules/task/generation-task.js";

const miniTools = new Hono<{ Variables: AuthVariables }>();

miniTools.use("*", requireAuth);


/**
 * Quote a planned video run with the admission's own computation and write nothing (§97 D26-1).
 * @param c - Hono context with the planned request admission would take.
 * @returns `200` with `{ credits }`.
 * @throws {AppError} The refusal admission would give the same body.
 */
miniTools.post(
  "/quote",
  rateLimitFor("mini_tool_quote", "user"),
  validate("json", miniToolPlannedRequestSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    try {
      return c.json({ data: await quoteMiniToolExecution(body, user.id) }, 200);
    } catch (err) {
      logger.error({ err, ctx: { userId: user.id, projectId: body.project_id, spaceId: body.space_id, runId: body.run_id, tool: body.tool } }, "mini_tool_quote_failed");
      throw err;
    }
  },
);

/**
 * Run one mini-tool onto the result nodes the browser built.
 * @param c - Hono context with the validated request.
 * @returns `201` with `{ task_id, status }` — `"pending"` once queued,
 * `"failed"` when the run was refused after its rows opened (the rows hold
 * the cause).
 * @throws {AppError} The refusal itself, when no row was opened to carry it.
 */
miniTools.post(
  "/",
  rateLimitFor("mini_tool", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", miniToolSubmissionSchema),
  runOnce("mini-tool"),
  async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  if ("run_id" in body) {
    try {
      const record = await acceptMiniToolExecution(body, user.id, (accepted) => miniToolPlannedRunService.startPlannedMiniToolRun(accepted, user.id));
      return c.json({ data: { task_id: record.taskId, status: record.status } }, 201);
    } catch (err) {
      logger.error({ err, ctx: { userId: user.id, projectId: body.project_id, spaceId: body.space_id, runId: body.run_id, tool: body.tool } },
        err instanceof ConflictError ? "mini_tool_planned_identity_conflict" : "mini_tool_planned_admission_failed");
      throw err;
    }
  }
  const spec = miniToolById(body.tool)!;

  await projectService.assertAccess(body.project_id, user.id, "editor");
  const run = await prepareRun(spec, body);

  const taskType = outputTemplateOf(spec).modality;
  const task = await admitGeneration(
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
