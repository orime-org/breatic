// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import type { TaskEntity } from "@breatic/shared";
import { canonicalMiniToolValue, hashMiniToolValue, miniToolPlannedRequestSchema, miniToolSourceBindingSchema } from "@breatic/shared/mini-tools";
import type { AcceptedMiniToolExecution } from "@domain/mini-tool/execution-admission.service.js";
import * as taskRepo from "@domain/task/task.repo.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const storedPlanSchema = z.strictObject({
  schemaVersion: z.literal(1), tool: z.literal("video.remove-bg"),
  taskId: z.uuid(), projectId: z.uuid(), spaceId: z.uuid(), targetNodeIds: z.array(z.uuid()),
  binding: miniToolSourceBindingSchema, sourceKey: z.string().min(1),
  draft: z.unknown(), analysisRefs: z.unknown(), outputs: z.unknown(), model: z.string().min(1),
  provider: z.strictObject({ provider: z.literal("wavespeed"), model_id: z.literal("bria/fibo/video-background-remover") }),
  body: z.strictObject({ video: z.string().url(), background_color: z.literal("Transparent"), output_container_and_codec: z.literal("webm_vp9"), preserve_audio: z.literal(true) }),
  credits: z.number().nonnegative(), requestFingerprint: fingerprint, planFingerprint: fingerprint,
});

/** The original SQL parent and its verified immutable execution plan. */
export interface MiniToolExecutionPlan { task: TaskEntity; execution: AcceptedMiniToolExecution }

/**
 * Bind every executable field to the original parent and complete persisted plan.
 * @param taskId - The immutable accepted run UUID.
 * @returns The physical parent and complete verified plan, including hidden history.
 * @throws {z.ZodError} When persisted fields violate their versioned contract.
 * @throws {Error} When the parent lane, identity, output mapping or complete plan hash differs.
 */
export async function readMiniToolExecutionPlan(taskId: string): Promise<MiniToolExecutionPlan> {
  const task = await taskRepo.getMiniToolExecutionTask(taskId);
  if (task === null || task.source !== "mini_tool" || task.taskType !== "video" || task.mode !== "append") {
    throw new Error("Planned video execution has no owning task");
  }
  const stored = storedPlanSchema.parse(task.params.miniToolExecution);
  const request = miniToolPlannedRequestSchema.parse({
    tool: stored.tool, project_id: stored.projectId, space_id: stored.spaceId, run_id: stored.taskId,
    draft: stored.draft, analysis_refs: stored.analysisRefs, outputs: stored.outputs,
  });
  const execution: AcceptedMiniToolExecution = { ...stored, draft: request.draft, analysisRefs: request.analysis_refs, outputs: request.outputs };
  const { requestFingerprint: _requestFingerprint, planFingerprint, ...projection } = execution;
  if (execution.taskId !== task.id || execution.projectId !== task.projectId || execution.spaceId !== task.spaceId
    || canonicalMiniToolValue(execution.targetNodeIds) !== canonicalMiniToolValue(execution.outputs.map((output) => output.nodeId))
    || await hashMiniToolValue(projection) !== planFingerprint) {
    throw new Error("Planned execution differs from its original parent or complete plan");
  }
  return { task, execution };
}
