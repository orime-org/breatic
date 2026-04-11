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
import * as taskService from "../modules/task.service.js";
import * as nodeHistoryService from "../modules/node-history.service.js";
import { createQueue } from "../infra/queue.js";
import { getRedis } from "../infra/redis.js";
import { acquireNodeLock } from "../infra/canvas-lock.js";
import { publishNodeEvent } from "../infra/event-stream.js";
import { ConflictError, ValidationError } from "../errors.js";

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

  const redis = getRedis();
  const actor = {
    userId: user.id,
    username: user.email,
  };

  // Acquire the node lock before creating the task so that a second
  // concurrent request is rejected cleanly with a 409 and never
  // enqueues a duplicate BullMQ job.
  if (nodeId && projectId) {
    const acquired = await acquireNodeLock(redis, projectId, nodeId, actor);
    if (!acquired) {
      throw new ConflictError(
        "Another user is currently handling this node. Try again after they finish.",
      );
    }
  }

  const task = await taskService.create(
    user.id,
    projectId,
    body.task_type,
    body.params,
    body.model,
    body.skill_name,
    body.source,
  );

  const job = await tasksQueue.add("execute-task", {
    taskId: task.id,
    userId: user.id,
    projectId,
    taskType: body.task_type,
    model: body.model,
    skillName: body.skill_name,
    params: body.params,
    source: body.source,
  });

  await taskService.setJobId(task.id, job.id ?? "");

  // Broadcast `handling` so every collaborator sees the node enter
  // its busy state immediately — before the Worker picks up the job.
  if (nodeId && projectId) {
    await publishNodeEvent(redis, {
      type: "handling",
      projectId,
      nodeId,
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

  const job = await tasksQueue.add("execute-task", {
    taskId: task.id,
    userId: user.id,
    projectId: body.project_id,
    taskType: "understand",
    model: body.model,
    params,
  });

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
    const nodeId = c.req.param("nodeId");
    const { project_id, limit, offset, status } = c.req.valid("query");

    const result = await nodeHistoryService.listByNode(project_id, nodeId, {
      limit,
      offset,
      status,
    });

    return c.json({ data: result.entries, total: result.total });
  },
);

export { canvas as canvasRoute };
