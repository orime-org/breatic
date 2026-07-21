// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { projectService, authService, precheckCredits } from "@server/modules";
import { createQueue, defaultJobOpts } from "@breatic/core";
import {
  AppError,
  ValidationError,
  ConflictLockedError,
  publishNodeEvent,
  getStreamRedis,
  logger,
} from "@breatic/core";
import { acquireCanvasNodeLock, readCanvasNodeLockHolder, releaseCanvasNodeLock } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";

const canvas = new Hono<{ Variables: AuthVariables }>();

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
canvas.post("/tasks", zValidator("json", taskCreateSchema), async (c) => {
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
    throw new ValidationError("node_ids requires project_id");
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
  // gets an immediate 400 instead. This is NOT a billing guard: billing is
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
      "This model requires a source input (e.g. params.images / video_url / audio_url).",
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
      `This model accepts at most ${countViolation.limit} '${countViolation.field}'; ${countViolation.actual} were provided.`,
    );
  }

  // #1580 #7 credit pre-check (user decision 2026-07-03): refuse an
  // obviously-insufficient balance BEFORE creating the task. Non-locking
  // (no reservation) — the worker's atomic markCompletedAndBill remains
  // the billing source of truth; concurrent passes may drive the balance
  // negative, the accepted trade-off of a soft pre-check. Same shared
  // helper and 402 shape as the /mini-tools routes.
  const insufficient = await precheckCredits(
    user.id,
    estimateTaskCredits(body.model),
  );
  if (insufficient) {
    return c.json({ error: { code: 402, message: insufficient } }, 402);
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

  // Spec §10.13 + §10.15: `mode='overwrite'` claims an exclusive Redis
  // lock on the target node so concurrent overwrites can't both win. The
  // schema's `superRefine` already guarantees `target_node_id` is present
  // when mode is 'overwrite'; the assertion below is defense in depth.
  if (mode === "overwrite") {
    if (!targetNodeId) {
      // Should never reach here; schema validation rejects this case.
      throw new ValidationError(
        "target_node_id is required for overwrite mode",
      );
    }
    const acquired = await acquireCanvasNodeLock(
      projectId,
      targetNodeId,
      task.id,
    );
    if (!acquired) {
      // Lock held by another in-flight task. Look up the holder so the
      // client can render a meaningful toast (spec §10.15.3).
      const holderTaskId = await readCanvasNodeLockHolder(
        projectId,
        targetNodeId,
      );
      const holderTask = holderTaskId
        ? await taskService.getByIdInternal(holderTaskId)
        : null;
      const holder = holderTask
        ? await authService.getUserById(holderTask.userId)
        : null;
      // Roll back our just-created task so it doesn't sit in pending forever.
      await taskService.markFailed(
        task.id,
        "Lock held by another task; aborted",
      );
      throw new ConflictLockedError({
        holdingBy: holderTask?.userId ?? null,
        // Display names live on the personal studio / live awareness roster
        // now, not on `users` — fall back to the holder's email (or a
        // generic label) so the toast always has *something* to show; the
        // client refines via the in-canvas roster (email-registration
        // rewrite, 2026-06-06).
        holdingByName: holder?.email ?? "someone",
        taskId: holderTaskId,
        startedAt: holderTask?.startedAt?.getTime() ?? Date.now(),
        // Conservative default; refined per-model in a follow-up PR.
        estimatedSeconds: 30,
      });
    }
    // Lock acquired. Publish a `state='handling'` event right away so
    // collaborators see the node enter handling without waiting for the
    // worker to start (spec §10.15.4 — collaboration visibility).
    // #1580 adversarial fix: under gen fencing this OPEN is a HARD
    // prerequisite, not best-effort — it is what installs the live
    // handlingBy.gen (and advances leaseGen) that every worker write-back
    // CAS-checks against. If it cannot be published, enqueueing anyway
    // would bill the user for a result that can never land on the node.
    try {
      await publishNodeEvent(getStreamRedis(), {
        type: "node-state-update",
        docName: canvasSpaceDocName(projectId, spaceId),
        nodeId: targetNodeId,
        // #1580 #7: the frontend read the node's leaseGen and sent
        // gen = leaseGen + 1 in the body (schema guarantees coverage for
        // the target node). Collab applies this open iff gen >= leaseGen
        // and advances the counter; the worker echoes the same gen in
        // every write-back for the CAS.
        gen: body.node_gens![targetNodeId]!,
        update: {
          state: "handling",
          handlingBy: {
            userId: user.id,
            // No display-name snapshot — collaborators render "who is
            // handling" from the live `meta.users[userId]` awareness
            // roster, which updates on rename (email-registration
            // rewrite, 2026-06-06).
            // Worker-driven path — this endpoint dispatches BullMQ jobs.
            // Collab `onDisconnect` leaves backend-driven handling nodes
            // alone; Worker owns the terminal state transition.
            type: "backend",
            // Lease start (#1569): the collab sweeper reclaims this node
            // if it is still handling past its budget (the worker-crash /
            // stalled-death safety net). Server-authored (NTP-bounded), so
            // it is trusted directly — no client-clock normalization needed.
            startedAt: Date.now(),
            // #1580 #2: the QUEUE phase (enqueue → Worker pickup). The Worker
            // re-stamps to phase 'running' at markRunning, so a long queue
            // backlog does not eat into the execution budget window.
            phase: "queued",
            // #1580 #7: owner gen — same value as event.gen above.
            gen: body.node_gens![targetNodeId]!,
          },
        },
      });
    } catch (err) {
      logger.error(
        { err, projectId, targetNodeId, taskId: task.id },
        "handling-open publish failed; aborting task before enqueue",
      );
      await taskService.markFailed(
        task.id,
        "Failed to publish handling-open event; task aborted before enqueue",
      );
      // Free the node for a retry — this task will never run.
      await releaseCanvasNodeLock(projectId, targetNodeId, task.id);
      throw new AppError(503, "Task event stream unavailable; please retry");
    }
  }

  // Per spec §4.2: worker reads targetNodeIds to emit NodeStateUpdateEvent
  // and writes the result back into `project-{projectId}/canvas-{spaceId}`
  // (v10 multi-doc). The job payload carries spaceId so the worker can
  // compute the canvas-{spaceId} doc name without reloading the task row.
  // `mode` rides along so the worker knows whether to verify + release
  // the canvas-node lock on completion.
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
      // #1580 #7: lease gen per target node, echoed by every worker
      // write-back so the collab CAS can fence superseded writes.
      nodeGens: body.node_gens,
      mode,
    },
    defaultJobOpts(),
  );

  await taskService.setJobId(task.id, job.id ?? "");

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
canvas.post("/understand", zValidator("json", understandSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Cross-tenant guard — see /canvas/tasks rationale.
  await projectService.assertAccess(body.project_id, user.id, "editor");

  // #1580 adversarial fix: understand tasks invoke real vision/ASR models
  // and are billed at completion like every other task — this route was the
  // only enqueue path without the shared credit pre-check.
  const insufficientUnderstand = await precheckCredits(
    user.id,
    estimateTaskCredits(body.model),
  );
  if (insufficientUnderstand) {
    return c.json({ error: { code: 402, message: insufficientUnderstand } }, 402);
  }

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
  zValidator("param", z.object({ nodeId: z.string().uuid() })),
  zValidator("query", nodeHistoryQuerySchema),
  async (c) => {
    const user = c.get("user");
    // nodeId is a canvas node UUID (node_history.node_id is uuid) — validated
    // here so a malformed id is a 400, not a uuid-cast 500 inside the query.
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

export { canvas as canvasRoute };
