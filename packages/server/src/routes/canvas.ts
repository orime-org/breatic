/**
 * Canvas routes — task management.
 *
 * Provides endpoints for creating tasks (enqueued to BullMQ)
 * and listing tasks. Task results are delivered to the frontend
 * via Yjs document sync through the Hocuspocus collab server.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { z } from "zod";
import {
  taskCreateSchema,
  understandSchema,
  paginationSchema,
} from "./schemas.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import { taskService } from "@breatic/core";
import { nodeHistoryService } from "@breatic/core";
import { projectService } from "@breatic/core";
import { createQueue, defaultJobOpts } from "@breatic/core";
import { getRedis, getStreamRedis } from "@breatic/core";
import { acquireNodeLock } from "@breatic/core";
import { publishNodeEvent } from "@breatic/core";
import { ConflictError, ValidationError } from "@breatic/core";

const canvas = new Hono<{ Variables: AuthVariables }>();

canvas.use("*", requireAuth);

const tasksQueue = createQueue("tasks");

/**
 * `POST /canvas/tasks` — create a task and enqueue it for execution.
 *
 * Creates a task record and adds a BullMQ job for processing.
 *
 * @param c - Hono context with validated `taskCreateSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
canvas.post("/tasks", zValidator("json", taskCreateSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Node lock + state broadcast require a projectId + nodeId. Agent
  // chat / standalone tasks without a node just skip the lock step.
  const nodeId = body.params.node_id as string | undefined;
  const projectId = body.project_id;

  if (nodeId && !projectId) {
    throw new ValidationError("node_id requires project_id");
  }

  // Cross-tenant guard: never trust body.project_id. Without this,
  // any logged-in user who knows a victim project UUID can enqueue
  // a task that writes into that project's canvas node and is billed
  // to the attacker's own account.
  if (projectId) {
    await projectService.assertAccess(projectId, user.id);
  }

  const redis = getRedis();
  const streamRedis = getStreamRedis();
  const actor = {
    userId: user.id,
    username: user.email,
  };

  const task = await taskService.create(
    user.id,
    projectId,
    body.task_type,
    body.params,
    body.model,
    body.skill_name,
    body.source,
  );

  // Acquire the node lock with taskId so only this task can release it.
  if (nodeId && projectId) {
    const acquired = await acquireNodeLock(redis, projectId, nodeId, actor, task.id);
    if (!acquired) {
      throw new ConflictError(
        "Another user is currently handling this node. Try again after they finish.",
      );
    }
  }

  const job = await tasksQueue.add(
    "execute-task",
    {
      taskId: task.id,
      userId: user.id,
      projectId,
      taskType: body.task_type,
      model: body.model,
      skillName: body.skill_name,
      params: body.params,
      source: body.source,
    },
    defaultJobOpts(),
  );

  await taskService.setJobId(task.id, job.id ?? "");

  // Broadcast `handling` so every collaborator sees the node enter
  // its busy state immediately — before the Worker picks up the job.
  if (nodeId && projectId) {
    await publishNodeEvent(streamRedis, {
      type: "handling",
      projectId,
      nodeId,
      taskId: task.id,
      actor,
    });
  }

  return c.json({ data: { task_id: task.id, status: "pending" } }, 201);
});

/**
 * `POST /canvas/understand` — create an understand/transcription task.
 *
 * Convenience endpoint that wraps the task creation flow with
 * `task_type="understand"`.
 *
 * @param c - Hono context with validated `understandSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
canvas.post("/understand", zValidator("json", understandSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Cross-tenant guard — see /canvas/tasks rationale.
  if (body.project_id) {
    await projectService.assertAccess(body.project_id, user.id);
  }

  const params: Record<string, unknown> = {
    source_type: body.source_type,
    source_url: body.source_url,
    prompt: body.prompt,
  };

  const task = await taskService.create(
    user.id,
    body.project_id,
    "understand",
    params,
    body.model,
  );

  const job = await tasksQueue.add(
    "execute-task",
    {
      taskId: task.id,
      userId: user.id,
      projectId: body.project_id,
      taskType: "understand",
      model: body.model,
      params,
    },
    defaultJobOpts(),
  );

  await taskService.setJobId(task.id, job.id ?? "");

  return c.json({ data: { task_id: task.id, status: "pending" } }, 201);
});

/**
 * `GET /canvas/tasks` — list tasks for the current user.
 *
 * @param c - Hono context with optional pagination query params
 * @returns Paginated array of task entities
 */
canvas.get("/tasks", zValidator("query", paginationSchema), async (c) => {
  const user = c.get("user");
  const { limit, offset } = c.req.valid("query");
  const tasks = await taskService.list(user.id, limit, offset);
  return c.json({ data: tasks });
});

/**
 * `GET /canvas/nodes/:nodeId/history` — list a node's content history.
 *
 * Returns AIGC generation results (success + failed) and user uploads
 * for the given canvas node, ordered by most recent first. Used by the
 * frontend to show version history and support restore.
 *
 * @param c - Hono context, requires `project_id` query param
 * @returns `{ data: NodeHistoryEntity[], total: number }`
 */
const nodeHistoryQuerySchema = z.object({
  project_id: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: z.enum(["success", "failed"]).optional(),
});

canvas.get(
  "/nodes/:nodeId/history",
  zValidator("query", nodeHistoryQuerySchema),
  async (c) => {
    const user = c.get("user");
    const nodeId = c.req.param("nodeId");
    const { project_id, limit, offset, status } = c.req.valid("query");

    // Cross-tenant guard — node history includes every old version
    // of every AIGC / upload for the node, including failed-run
    // error messages. Without this check any logged-in user could
    // enumerate a victim project's history by guessing UUIDs.
    await projectService.assertAccess(project_id, user.id);

    const result = await nodeHistoryService.listByNode(project_id, nodeId, {
      limit,
      offset,
      status,
    });

    return c.json({ data: result.entries, total: result.total });
  },
);

export { canvas as canvasRoute };
