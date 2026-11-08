// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D Space's tasks (inner#1690, inner#1691): an editor submits a 3D
 * generation, every member reads the list, an editor checks a timed-out
 * generation against the queue and removes a finished-without-result row, and
 * the uploader reports bytes that never reached the edge.
 */

import { Hono } from "hono";
import { z } from "zod";
import { sceneGenerationBodySchema, t } from "@breatic/shared";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { runOnce } from "@server/middleware/run-once.js";
import { validate } from "@server/middleware/validate.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";
import { holdRun, sceneGenerationService, sceneTasksService } from "@server/modules";

const threeDTasks = new Hono<{ Variables: AuthVariables }>();
const spaceParams = z.object({ projectId: z.uuid(), spaceId: z.uuid() });
const taskParams = spaceParams.extend({ taskId: z.uuid() });

threeDTasks.post(
  "/:projectId/three-d/:spaceId/generations",
  requireAuth,
  rateLimitFor("generate", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("param", spaceParams),
  validate("json", sceneGenerationBodySchema),
  runOnce("generate"),
  async (c) => {
    const { projectId, spaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const userId = c.get("user").id;
    const held = await holdRun({
      projectId,
      userId,
      check: () => sceneGenerationService.checkSubmission(projectId, body),
      credits: sceneGenerationService.estimateOf,
    });
    const answer = await sceneGenerationService.startSceneGeneration(userId, projectId, spaceId, body, held);
    return c.json({ data: answer }, 201);
  },
);

threeDTasks.get("/:projectId/three-d/:spaceId/tasks", requireAuth, validate("param", spaceParams), async (c) => {
  const { projectId, spaceId } = c.req.valid("param");
  return c.json({ data: await sceneTasksService.listSpaceTasks(c.get("user").id, projectId, spaceId) });
});

threeDTasks.post("/:projectId/three-d/:spaceId/tasks/:taskId/check", requireAuth, validate("param", taskParams), async (c) => {
  const { projectId, spaceId, taskId } = c.req.valid("param");
  return c.json({ data: await sceneTasksService.checkSpaceTask(c.get("user").id, projectId, spaceId, taskId) });
});

threeDTasks.delete("/:projectId/three-d/:spaceId/tasks/:taskId", requireAuth, validate("param", taskParams), async (c) => {
  const { projectId, spaceId, taskId } = c.req.valid("param");
  const result = await sceneTasksService.removeSpaceTask(c.get("user").id, projectId, spaceId, taskId);
  if (result.removed) return c.json({ data: { removed: true } });
  // A timed-out generation that may still, or already did, produce a result
  // stays; the outcome tells the panel which, and on `has_result` the row now
  // holds it.
  const message = result.outcome === "running" ? t("server.three_d.still_running") : t("server.three_d.has_result");
  return c.json({ error: { code: 409, message, outcome: result.outcome } }, 409);
});

threeDTasks.post(
  "/:projectId/three-d/:spaceId/tasks/:taskId/failure",
  requireAuth,
  validate("param", taskParams),
  validate("json", z.object({ reason: z.literal("aborted") })),
  async (c) => {
    const { projectId, spaceId, taskId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return c.json({ data: await sceneTasksService.reportSpaceTaskFailure(c.get("user").id, projectId, spaceId, taskId, reason) });
  },
);

export { threeDTasks as threeDTasksRoute };
