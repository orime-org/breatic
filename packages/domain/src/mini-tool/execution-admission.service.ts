// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, getMiniToolsConfig, projectAuthService } from "@breatic/core";
import { TaskStatus, t, type TaskEntity, type TaskStatusType } from "@breatic/shared";
import { hashMiniToolValue, miniToolPlannedRequestSchema, type MiniToolPlannedRequest, type MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import { prepareVideoRemoveBackground, type PreparedVideoRemoveBackground } from "@domain/mini-tool/remove-background-preparation.service.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** The original server-owned execution stored under tasks.params.miniToolExecution. */
export interface AcceptedMiniToolExecution {
  schemaVersion: 1;
  tool: MiniToolPlannedRequest["tool"];
  taskId: string;
  projectId: string;
  spaceId: string;
  targetNodeIds: string[];
  binding: MiniToolSourceBinding;
  sourceKey: string;
  draft: MiniToolPlannedRequest["draft"];
  analysisRefs: MiniToolPlannedRequest["analysis_refs"];
  outputs: MiniToolPlannedRequest["outputs"];
  model: string;
  provider: PreparedVideoRemoveBackground["provider"];
  body: PreparedVideoRemoveBackground["params"];
  credits: number;
  requestFingerprint: string;
  planFingerprint: string;
}

/** The narrow admission response, without prescribing terminal public result projection. */
export interface MiniToolExecutionAdmission {
  taskId: string;
  status: TaskStatusType;
}

/** The immutable task namespace, separate from analysis and worker-only steps. */
export interface MiniToolExecutionTaskParams extends Record<string, unknown> {
  miniToolExecution: AcceptedMiniToolExecution;
}

const replayIdentitySchema = z.object({
  schemaVersion: z.literal(1), tool: z.literal("video.remove-bg"),
  taskId: z.string().uuid(), projectId: z.string().uuid(), spaceId: z.string().uuid(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const statusSchema = z.enum(TaskStatus);

/**
 * Return the original run without consulting current source registrations or model configuration.
 * @param task - The existing physical parent, including an occupied UUID of another lane.
 * @param request - The complete frozen incoming submission.
 * @param userId - The authenticated editor.
 * @param fingerprint - The canonical hash of the complete incoming request.
 * @returns The existing identity and current computation status.
 * @throws {ConflictError} When the original lane, actor or complete request differs.
 * @throws {z.ZodError} When a persisted task status is invalid.
 */
function replay(task: TaskEntity, request: MiniToolPlannedRequest, userId: string, fingerprint: string): MiniToolExecutionAdmission {
  const identity = replayIdentitySchema.safeParse(task.params.miniToolExecution);
  if (task.source !== "mini_tool" || task.taskType !== "video" || task.userId !== userId
    || task.projectId !== request.project_id || task.spaceId !== request.space_id || !identity.success
    || identity.data.taskId !== task.id || identity.data.projectId !== task.projectId
    || identity.data.spaceId !== task.spaceId || identity.data.requestFingerprint !== fingerprint) {
    throw new ConflictError(t("server.idempotency.mismatch"));
  }
  return { taskId: task.id, status: statusSchema.parse(task.status) };
}

/**
 * Admit or replay a planned execution before its transport adapter starts it.
 * @param body - The complete press-frozen submission.
 * @param userId - The authenticated actor whose project role must be checked.
 * @param start - The application's row, hold and queue adapter, invoked only by the durable winner.
 * @returns The original task identity and its current status.
 * @throws {NotFoundError} When the target project is absent or the caller has no current membership.
 * @throws {ForbiddenError} When the caller can only view the target project.
 * @throws {ConflictError} When the run UUID already belongs to another owner or request.
 * @throws {ValidationError} When the registered video source is invalid.
 * @throws {AppError} When the selected model is unavailable or the source exceeds its declared limit.
 * @throws {Error} When persistence, preparation or the application's start adapter fails.
 */
export async function acceptMiniToolExecution(
  body: MiniToolPlannedRequest,
  userId: string,
  start: (accepted: AcceptedMiniToolExecution) => Promise<"pending" | "failed">,
): Promise<MiniToolExecutionAdmission> {
  const request = miniToolPlannedRequestSchema.parse(structuredClone(body));
  const role = await projectAuthService.loadProjectRole(userId, request.project_id);
  if (role === null) throw new NotFoundError(t("server.error.not_found"));
  if (role === "viewer") throw new ForbiddenError(t("server.error.forbidden"));
  const requestFingerprint = await hashMiniToolValue(request);
  const previous = await taskRepo.getMiniToolExecutionTask(request.run_id);
  if (previous !== null) return replay(previous, request, userId, requestFingerprint);

  const model = getMiniToolsConfig().executions[request.tool].model;
  const prepared = await prepareVideoRemoveBackground(request.draft.source, model);
  const plan = {
    schemaVersion: 1 as const, tool: request.tool, taskId: request.run_id,
    projectId: request.project_id, spaceId: request.space_id,
    targetNodeIds: [request.outputs[0]!.nodeId], binding: prepared.binding, sourceKey: prepared.sourceKey,
    draft: request.draft, analysisRefs: request.analysis_refs,
    outputs: [{ outputIndex: 0, nodeId: request.outputs[0]!.nodeId, recipe: { kind: "remove-bg" as const } }],
    model: prepared.model, provider: prepared.provider, body: prepared.params, credits: prepared.credits,
  };
  const accepted: AcceptedMiniToolExecution = { ...plan, requestFingerprint, planFingerprint: await hashMiniToolValue(plan) };
  const params: MiniToolExecutionTaskParams = { miniToolExecution: accepted };
  const inserted = await taskRepo.claimMiniToolExecutionTask({
    id: request.run_id, userId, projectId: request.project_id, spaceId: request.space_id,
    taskType: "video", model: prepared.model, params,
  });
  if (!inserted) {
    const winner = await taskRepo.getMiniToolExecutionTask(request.run_id);
    if (winner === null) throw new ConflictError(t("server.idempotency.mismatch"));
    return replay(winner, request, userId, requestFingerprint);
  }
  await start(accepted);
  const current = await taskRepo.getMiniToolExecutionTask(request.run_id);
  if (current === null) throw new Error("Accepted execution task disappeared");
  return { taskId: current.id, status: statusSchema.parse(current.status) };
}
