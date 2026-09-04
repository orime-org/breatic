// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas routes — task management.
 *
 * Provides endpoints for creating tasks (enqueued to BullMQ)
 * and listing tasks. Task results are delivered to the frontend
 * via Yjs document sync through the Hocuspocus collab server.
 */

import { Hono } from "hono";
import { validate } from "@server/middleware/validate.js";
import { secretsMatch } from "@server/utils/secrets-match.js";

import { z } from "zod";
import {
  taskCreateSchema,
  understandSchema,
  paginationSchema,
} from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import {
  getCanvasReferencePoolCap,
  getNodeHistoryPageSize,
} from "@server/config/limits.js";
import {
  taskService,
  estimateTaskCredits,
  violatesSourceRequirementForModel,
  violatesReferenceCountForModel,
} from "@breatic/domain";
import { nodeHistoryService } from "@breatic/domain";
import { nodeTaskService, emitNodeTaskCounts } from "@breatic/domain";
import { openGenerationTasks } from "@server/modules/task/generation-task.js";
import { assertSkillUsable } from "@breatic/domain";
import {
  assertStorageAllowance,
  precheckCredits,
  projectService,
} from "@server/modules";
import { createQueue, defaultJobOpts } from "@breatic/core";
import {
  ValidationError,
  getStreamRedis,
  logger,
  env,
} from "@breatic/core";
import { t } from "@breatic/shared";
import { canvasSpaceDocName } from "@breatic/shared";

const canvas = new Hono<{ Variables: AuthVariables }>();

/**
 * `POST /canvas/node-tasks/expired` — a task timer saying one task is out of
 * time (#186, design §4.6.1).
 *
 * Registered above the session middleware because the caller is our own
 * timer Durable Object, which holds the shared secret and no session. The
 * suite covering this endpoint asserts a secret-bearing call gets a 200, so
 * moving this below that line turns red.
 *
 * The timer knows only the task id. Every judgement is here: a row still
 * running becomes expired, a row already terminal is left alone because the
 * task finished before its deadline and the timer has no cancel. Both answer
 * 200 — a failure is retried by the timer forever, so only something a retry
 * could fix may fail.
 */
canvas.post(
  "/node-tasks/expired",
  async (c, next) => {
    const presented = c.req.header("x-ingest-secret") ?? "";
    if (
      !env.INGEST_SHARED_SECRET ||
      !secretsMatch(presented, env.INGEST_SHARED_SECRET)
    ) {
      logger.warn(
        { hasSecret: presented.length > 0 },
        "node_task_expiry_unauthorized",
      );
      return c.json(
        { error: { code: 401, message: t("server.auth.not_authenticated") } },
        401,
      );
    }
    await next();
  },
  validate("json", z.object({ task_id: z.string().uuid() })),
  async (c) => {
    const { task_id } = c.req.valid("json");

    const row = await nodeTaskService.findById(task_id);
    if (row === null) {
      // Knocking again cannot make this row appear. Answering anything but
      // 200 leaves the timer retrying for good.
      logger.warn({ taskId: task_id }, "node_task_expiry_no_such_task");
      return c.json({ data: { applied: false } });
    }

    const result = await nodeTaskService.settle({
      taskId: task_id,
      outcome: "expired",
      errorMessage: t("canvas.task.expired"),
    });

    // Sent whether or not this call moved the row: the counts were recomputed
    // either way, and a node whose numbers had drifted comes back into line.
    await emitNodeTaskCounts(
      getStreamRedis(),
      canvasSpaceDocName(row.projectId, row.spaceId),
      row.nodeId,
      result.counts,
    );

    return c.json({ data: { applied: result.applied } });
  },
);

canvas.use("*", requireAuth);

const tasksQueue = createQueue("tasks");

/**
 * `GET /canvas/limits` — frontend-consumed canvas knobs from
 * `config/limits.yaml` (#1782).
 *
 * `referencePoolCap`: max entries in one node's reference pool (incoming
 * reference edges + focus crops combined) — enforced by the frontend at
 * add time (the pool lives in Yjs; the server never gates collaborative
 * writes). Distinct from the per-model `images.max_items` payload cap
 * enforced at execute time (#1735).
 *
 * `nodeHistoryPageSize`: page size the frontend requests per infinite-scroll
 * page of a node's history (#1619).
 * @param c - Hono context (auth required, no params)
 * @returns `200` with `{ data: { referencePoolCap, nodeHistoryPageSize } }`
 */
canvas.get("/limits", (c) => {
  return c.json({
    data: {
      referencePoolCap: getCanvasReferencePoolCap(),
      nodeHistoryPageSize: getNodeHistoryPageSize(),
    },
  });
});

/**
 * `POST /canvas/tasks` — create a task and enqueue it for execution.
 *
 * Creates a task record and adds a BullMQ job for processing.
 * @param c - Hono context with validated `taskCreateSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
canvas.post("/tasks", validate("json", taskCreateSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const rawNodeIds = body.params.node_ids;
  const nodeIds = Array.isArray(rawNodeIds)
    ? rawNodeIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const projectId = body.project_id;
  const spaceId = body.space_id;
  const mode = body.mode;
  const targetNodeId = body.target_node_id;

  // node_ids without project_id no longer happens because project_id is
  // required in the schema, but keep the assertion as defense in depth
  // — schemas can drift, this branch should never hit at runtime.
  if (nodeIds.length > 0 && !projectId) {
    throw new ValidationError(t("server.error.validation"));
  }

  // Cross-tenant guard: never trust body.project_id. Without this,
  // any logged-in user who knows a victim project UUID can enqueue
  // a task that writes into that project's canvas node and is billed
  // to the attacker's own account.
  await projectService.assertAccess(projectId, user.id, "editor");

  // #1675 execute gate (cross-modality): a model whose modes all need a source
  // input (image / video / audio) must not be submitted without it (e.g. Nano
  // Banana Edit needs an image; a video-edit needs a video). Reject BEFORE
  // enqueue so a doomed submission never creates a task row, burns a worker
  // slot, or leaves the user waiting for a node that can only fail — the client
  // gets an immediate 422 instead. This is NOT a billing guard: billing is
  // post-success (markCompletedAndBill), so a source-less run that reached the
  // worker would fail and never bill anyway — the gate saves the doomed attempt,
  // not the credits. Defence in depth behind the Generate panel's frontend gate;
  // the rule is the same per-mode `sourcesByMode` the frontend reads, applied
  // here to params.
  if (violatesSourceRequirementForModel(body.model, body.params)) {
    // Structured record for security monitoring: a rejection here means the
    // frontend gate was bypassed (crafted request) or drifted — worth a trace.
    logger.warn(
      { userId: user.id, projectId, model: body.model, reason: "missing_source" },
      "execute_gate_rejected",
    );
    throw new ValidationError(
      t("server.canvas.model_requires_source"),
    );
  }

  // #1735 reference-count gate: a submission that over-fills a capped list
  // param (e.g. more reference images than the model's `max_items`) is rejected
  // BEFORE enqueue so the user is told, rather than the worker silently
  // truncating (providers/shared.ts). Same gate location as the source check.
  const countViolation = violatesReferenceCountForModel(body.model, body.params);
  if (countViolation) {
    logger.warn(
      {
        userId: user.id,
        projectId,
        model: body.model,
        reason: "too_many_references",
        field: countViolation.field,
        limit: countViolation.limit,
        actual: countViolation.actual,
      },
      "execute_gate_rejected",
    );
    throw new ValidationError(
      t("server.canvas.too_many_inputs", { limit: countViolation.limit, actual: countViolation.actual }),
    );
  }

  // #1580 #7 credit pre-check (user decision 2026-07-03): refuse an
  // obviously-insufficient balance BEFORE creating the task. Non-locking
  // (no reservation) — the worker's atomic markCompletedAndBill remains
  // the billing source of truth; concurrent passes may drive the balance
  // negative, the accepted trade-off of a soft pre-check. Same shared
  // helper and 402 shape as the /mini-tools routes.
  await precheckCredits(projectId, user.id, estimateTaskCredits(body.model));

  // #89: storage gate, the other soft pre-check. AFTER credits, because
  // refusing for storage tells the studio's admin about it — and a request
  // that was going to be refused for credits anyway should not send anyone
  // mail about storage.
  await assertStorageAllowance(projectId, "generate");

  // Same gate the chat entry uses. This path had none: a skill_name went
  // from the request body into the task row and the queue untouched.
  if (body.skill_name) {
    assertSkillUsable(body.skill_name, "canvas");
  }

  const task = await taskService.create(
    user.id,
    projectId,
    spaceId,
    body.task_type,
    mode,
    body.params,
    body.model,
    body.skill_name,
    body.source,
  );

  // A node carries several tasks at once (#186), so an overwrite claims
  // nothing: whichever result the user keeps is decided on the node's task
  // list. The schema's `superRefine` guarantees `target_node_id` is present
  // when mode is 'overwrite'; the assertion below is defense in depth.
  if (mode === "overwrite") {
    if (!targetNodeId) {
      // Should never reach here; schema validation rejects this case.
      throw new ValidationError(
        t("server.error.validation"),
      );
    }
  }

  // Per spec §4.2: the worker reads targetNodeIds to settle each node's task
  // row and writes the result back into `project-{projectId}/canvas-{spaceId}`
  // (v10 multi-doc). The job payload carries spaceId so the worker can
  // compute the canvas-{spaceId} doc name without reloading the task row.
  const job = await tasksQueue.add(
    "execute-task",
    {
      taskId: task.id,
      userId: user.id,
      projectId,
      spaceId,
      taskType: body.task_type,
      model: body.model,
      skillName: body.skill_name,
      params: body.params,
      source: body.source,
      targetNodeIds: targetNodeId ? [targetNodeId] : [],
      mode,
    },
    defaultJobOpts(),
  );

  await taskService.setJobId(task.id, job.id ?? "");

  // One task row per node this run will write to (#186, design §4.2). An
  // append-mode run names none: its result node is one the browser creates,
  // so there is no corner to count in yet.
  await openGenerationTasks({
    projectId,
    spaceId,
    nodeIds: targetNodeId ? [targetNodeId] : [],
    startedByUserId: user.id,
    taskId: task.id,
    // What the list shows for this row. The model names it when there is
    // one; a skill run names the skill, and the rest name what they are.
    label: body.model ?? body.skill_name ?? body.task_type,
  });

  return c.json({ data: { task_id: task.id, status: "pending" } }, 201);
});

/**
 * `POST /canvas/understand` — create an understand/transcription task.
 *
 * Convenience endpoint that wraps the task creation flow with
 * `task_type="understand"`.
 * @param c - Hono context with validated `understandSchema` body
 * @returns `201` with `{ task_id, status: "pending" }`
 */
canvas.post("/understand", validate("json", understandSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Cross-tenant guard — see /canvas/tasks rationale.
  await projectService.assertAccess(body.project_id, user.id, "editor");

  // #1580 adversarial fix: understand tasks invoke real vision/ASR models
  // and are billed at completion like every other task — this route was the
  // only enqueue path without the shared credit pre-check.
  await precheckCredits(body.project_id, user.id, estimateTaskCredits(body.model));

  const params: Record<string, unknown> = {
    source_type: body.source_type,
    source_url: body.source_url,
    prompt: body.prompt,
  };

  // Understand tasks transcribe / analyze a media URL into a result node;
  // they always produce a new node ('append'), no overwrite semantics.
  const task = await taskService.create(
    user.id,
    body.project_id,
    body.space_id,
    "understand",
    "append",
    params,
    body.model,
  );

  const job = await tasksQueue.add(
    "execute-task",
    {
      taskId: task.id,
      userId: user.id,
      projectId: body.project_id,
      spaceId: body.space_id,
      taskType: "understand",
      model: body.model,
      params,
      mode: "append" as const,
    },
    defaultJobOpts(),
  );

  await taskService.setJobId(task.id, job.id ?? "");

  return c.json({ data: { task_id: task.id, status: "pending" } }, 201);
});

/**
 * `GET /canvas/tasks` — list tasks for the current user.
 * @param c - Hono context with optional pagination query params
 * @returns Paginated array of task entities
 */
canvas.get("/tasks", validate("query", paginationSchema), async (c) => {
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
 * @param c - Hono context, requires `project_id` query param
 * @returns `{ data: { entries: NodeHistoryEntity[], total: number } }`
 */
const nodeHistoryQuerySchema = z.object({
  project_id: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: z.enum(["success", "failed"]).optional(),
});

canvas.get(
  "/nodes/:nodeId/history",
  validate("param", z.object({ nodeId: z.string().uuid() })),
  validate("query", nodeHistoryQuerySchema),
  async (c) => {
    const user = c.get("user");
    // nodeId is a canvas node UUID (node_history.node_id is uuid) — validated
    // here so a malformed id is a 422, not a uuid-cast 500 inside the query.
    const { nodeId } = c.req.valid("param");
    const { project_id, limit, offset, status } = c.req.valid("query");

    // Cross-tenant guard — node history includes every old version
    // of every AIGC / upload for the node, including failed-run
    // error messages. Without this check any logged-in user could
    // enumerate a victim project's history by guessing UUIDs.
    // History is a read; view-or-above is enough.
    await projectService.assertAccess(project_id, user.id, "viewer");

    const result = await nodeHistoryService.listByNode(project_id, nodeId, {
      limit,
      offset,
      status,
    });

    // Envelope: entries + total nested under `data` so the frontend reads it
    // with the single `apiGet` `{ data: T }` unwrap (#1619) — the endpoint is
    // greenfield, so this aligns it with the rest of the list endpoints.
    return c.json({ data: { entries: result.entries, total: result.total } });
  },
);

/**
 * `GET /canvas/nodes/:nodeId/tasks` — the rows behind a node's four counts.
 *
 * The canvas document carries four numbers (#186 design §3.3); the detail
 * comes from here, and only when the user opens the panel. Same cross-tenant
 * guard as the history endpoint above: the rows name who started each task
 * and why one failed.
 * @param c - Hono context; `project_id` in the query, node id in the path.
 * @returns `{ data: { tasks: NodeTaskRow[] } }`, newest first.
 */
canvas.get(
  "/nodes/:nodeId/tasks",
  validate("param", z.object({ nodeId: z.string().uuid() })),
  validate("query", z.object({ project_id: z.string().uuid() })),
  async (c) => {
    const user = c.get("user");
    const { nodeId } = c.req.valid("param");
    const { project_id } = c.req.valid("query");

    await projectService.assertAccess(project_id, user.id, "viewer");

    const tasks = await nodeTaskService.listLive({
      projectId: project_id,
      nodeId,
    });
    return c.json({ data: { tasks } });
  },
);

/**
 * `DELETE /canvas/node-tasks/:taskId` — the user is done with one record.
 *
 * One endpoint for both buttons the list shows. "Finish" and "Clear" are the
 * same request; which one it was is decided by the state the row is already
 * in, and a row still running is neither — the service answers 409.
 *
 * The query carries the caller's own node so the counts can still be
 * recomputed when this table does not hold the row: the user is acting on a
 * projection the server cannot see, and "clear this" means clear it (design
 * §7.4). That case is logged and answered 200, not refused.
 * @param c - Hono context; task id in the path, the caller's project, space
 *   and node in the query.
 * @returns `{ data: { removed: boolean, counts: NodeTaskCounts } }`
 * @throws {AppError} 403 when the caller may not write the project the row
 *   belongs to; 409 when the task has not settled yet.
 */
canvas.delete(
  "/node-tasks/:taskId",
  validate("param", z.object({ taskId: z.string().uuid() })),
  validate(
    "query",
    z.object({
      project_id: z.string().uuid(),
      space_id: z.string().uuid(),
      node_id: z.string().uuid(),
    }),
  ),
  async (c) => {
    const user = c.get("user");
    const { taskId } = c.req.valid("param");
    const { project_id, space_id, node_id } = c.req.valid("query");

    const row = await nodeTaskService.findById(taskId);

    // Cross-tenant guard. The path holds a task id and nothing else, so the
    // project to check against is read from the row — never from the query,
    // which the caller controls. With no row there is nothing to read and
    // the caller's own project is all there is; they still have to prove
    // they may write it.
    const projectId = row?.projectId ?? project_id;
    const spaceId = row?.spaceId ?? space_id;
    const nodeId = row?.nodeId ?? node_id;
    await projectService.assertAccess(projectId, user.id, "editor");

    const result = await nodeTaskService.dismiss({
      taskId,
      projectId,
      nodeId,
    });

    if (row === null) {
      logger.warn(
        { taskId, projectId, nodeId, userId: user.id },
        "node_task dismiss: no such row, recounting anyway",
      );
    }

    await emitNodeTaskCounts(
      getStreamRedis(),
      canvasSpaceDocName(projectId, spaceId),
      nodeId,
      result.counts,
    );

    return c.json({ data: result });
  },
);

export { canvas as canvasRoute };
