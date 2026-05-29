/**
 * Mini-tool routes — lightweight AIGC operations.
 *
 * Each endpoint accepts a discriminated union body (keyed by `tool`),
 * creates a task record, and enqueues a BullMQ job. Audio tools with
 * `tts` or `voice-clone` map to `task_type="tts"`. Task results are
 * delivered via Yjs document sync through the Hocuspocus collab server.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import {
  imageToolSchema,
  videoToolSchema,
  audioToolSchema,
} from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { taskService, creditService, env } from "@breatic/core";
import { createQueue, defaultJobOpts } from "@breatic/core";

const miniTools = new Hono<{ Variables: AuthVariables }>();

miniTools.use("*", requireAuth);

const tasksQueue = createQueue("tasks");

/** TTS-class tool names that use task_type="tts" instead of "audio". */
const TTS_TOOLS = new Set(["tts", "voice-clone"]);

/** Minimum credit cost per tool — reject if user can't afford. */
const MIN_CREDIT_COST = 5;

/** Pre-check: reject if user has insufficient credits. */
async function checkCredits(userId: string): Promise<string | null> {
  if (!env.PAYMENT_ENABLED) return null;
  const balance = await creditService.getBalance(userId);
  if (balance < MIN_CREDIT_COST) {
    return `Insufficient credits. Required: ${MIN_CREDIT_COST}, available: ${balance}`;
  }
  return null;
}

/**
 * Shared helper — create task and enqueue BullMQ job.
 *
 * `params.node_ids: string[]` (optional, 1..N) identifies the result
 * nodes the Worker will update when the task completes. Absent for
 * tasks that don't bind to canvas nodes (rare for mini-tools).
 *
 * @param toolName - The specific mini-tool name (e.g. "remove-bg", "upscale")
 * @param taskType - High-level task type (e.g. "image", "video", "audio", "tts")
 * @param params - Tool-specific parameters from the validated body
 * @param userId - Authenticated user ID
 * @param projectId - Optional project ID
 * @param targetNodeIds - UUIDs of the canvas nodes to update on completion
 * @returns Object with `task_id` and `status: "pending"`
 */
async function enqueueMiniTool(
  toolName: string,
  taskType: string,
  params: Record<string, unknown>,
  userId: string,
  projectId: string,
  spaceId: string,
  targetNodeIds: string[] = [],
): Promise<{ task_id: string; status: string }> {
  // Mini-tools always create a new sibling result node (the caller
  // pre-allocates `target_node_id` as a fresh UUID), so mode is
  // unconditionally 'append'. No SETNX lock — fresh nodeId can't conflict.
  const task = await taskService.create(
    userId,
    projectId,
    spaceId,
    taskType,
    "append",
    params,
    undefined,
    undefined,
    "mini_tool",
  );

  // Worker dispatcher reads `source: "mini_tool"` to route to runMiniTool.
  // Without it, the job falls through to the AIGC direct path which expects
  // a `model` field that mini-tool requests don't provide. `spaceId` lets
  // the worker compute the canvas-{spaceId} doc name when emitting
  // NodeStateUpdateEvent (v10 multi-doc routing).
  const job = await tasksQueue.add(
    "execute-mini-tool",
    {
      taskId: task.id,
      userId,
      projectId,
      spaceId,
      toolName,
      taskType,
      params,
      source: "mini_tool",
      targetNodeIds,
      mode: "append" as const,
    },
    defaultJobOpts(),
  );

  await taskService.setJobId(task.id, job.id ?? "");

  return { task_id: task.id, status: "pending" };
}

/**
 * `POST /mini-tools/image` — run an image mini-tool.
 *
 * Accepts discriminated union body keyed by `tool` field (e.g.
 * "remove-bg", "upscale", "relight", "edit").
 *
 * @param c - Hono context with validated `imageToolSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
miniTools.post("/image", zValidator("json", imageToolSchema), async (c) => {
  const user = c.get("user");
  const err = await checkCredits(user.id);
  if (err) return c.json({ error: { code: 402, message: err } }, 402);

  const body = c.req.valid("json");
  const { tool, project_id, space_id, target_node_id, ...params } = body;

  const result = await enqueueMiniTool(
    tool,
    "image",
    params,
    user.id,
    project_id,
    space_id,
    [target_node_id],
  );
  return c.json({ data: result }, 201);
});

/**
 * `POST /mini-tools/video` — run a video mini-tool.
 *
 * Accepts discriminated union body keyed by `tool` field (e.g.
 * "upscale", "interpolate", "extend", "edit").
 *
 * @param c - Hono context with validated `videoToolSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
miniTools.post("/video", zValidator("json", videoToolSchema), async (c) => {
  const user = c.get("user");
  const err = await checkCredits(user.id);
  if (err) return c.json({ error: { code: 402, message: err } }, 402);

  const body = c.req.valid("json");
  const { tool, project_id, space_id, target_node_id, ...params } = body;

  const result = await enqueueMiniTool(
    tool,
    "video",
    params,
    user.id,
    project_id,
    space_id,
    [target_node_id],
  );
  return c.json({ data: result }, 201);
});

/**
 * `POST /mini-tools/audio` — run an audio mini-tool.
 *
 * Accepts discriminated union body keyed by `tool` field (e.g.
 * "sfx", "tts", "voice-clone", "separate"). Tools "tts" and
 * "voice-clone" are mapped to `task_type="tts"`.
 *
 * @param c - Hono context with validated `audioToolSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
miniTools.post("/audio", zValidator("json", audioToolSchema), async (c) => {
  const user = c.get("user");
  const err = await checkCredits(user.id);
  if (err) return c.json({ error: { code: 402, message: err } }, 402);

  const body = c.req.valid("json");
  const { tool, project_id, space_id, target_node_id, ...params } = body;

  const taskType = TTS_TOOLS.has(tool) ? "tts" : "audio";
  const result = await enqueueMiniTool(
    tool,
    taskType,
    params,
    user.id,
    project_id,
    space_id,
    [target_node_id],
  );
  return c.json({ data: result }, 201);
});

export { miniTools as miniToolsRoute };
