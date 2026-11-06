// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D Space's task list (inner#1690): every member reads it, an editor
 * removes a finished-without-result row, and the uploader reports bytes that
 * never reached the edge.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";
import { sceneTasksService } from "@server/modules";

const threeDTasks = new Hono<{ Variables: AuthVariables }>();
const spaceParams = z.object({ projectId: z.uuid(), spaceId: z.uuid() });
const taskParams = spaceParams.extend({ taskId: z.uuid() });

threeDTasks.get("/:projectId/three-d/:spaceId/tasks", requireAuth, validate("param", spaceParams), async (c) => {
  const { projectId, spaceId } = c.req.valid("param");
  return c.json({ data: await sceneTasksService.listSpaceTasks(c.get("user").id, projectId, spaceId) });
});

threeDTasks.delete("/:projectId/three-d/:spaceId/tasks/:taskId", requireAuth, validate("param", taskParams), async (c) => {
  const { projectId, spaceId, taskId } = c.req.valid("param");
  await sceneTasksService.removeSpaceTask(c.get("user").id, projectId, spaceId, taskId);
  return c.json({ data: { removed: true } });
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
