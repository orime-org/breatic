// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { db, env, getMiniToolsConfig } from "@breatic/core";
import { miniToolPlanJobRequestSchema, type MiniToolPlanJobRequest } from "@breatic/shared";
import { hashMiniToolValue } from "@breatic/shared/mini-tools";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import { openMiniToolConsumption } from "@domain/mini-tool/consumption-producer.service.js";
import { miniToolConsumptionRecordSchema, type MiniToolConsumptionRecord } from "@domain/mini-tool/consumption.types.js";

const inputSchema = z.strictObject({
  taskId: z.uuid(), stepId: z.uuid(), chunkIndex: z.number().int().nonnegative(),
  chargeTo: z.enum(["user", "platform"]), request: miniToolPlanJobRequestSchema,
});

/** Internal candidate request; public callers cannot supply pricing or multiplier. */
export type OpenMiniToolPlanJobInput = z.infer<typeof inputSchema>;
/** The committed first request and its independently unresolved expense. */
export interface OpenMiniToolPlanJobResult { request: MiniToolPlanJobRequest; consumption: MiniToolConsumptionRecord }

/**
 * Freeze a planned request and pending consumption together before any external IO.
 *
 * A retried producer may have allocated unused candidate keys. The first
 * persisted request wins and is returned unchanged, including its old deadline,
 * limits and price policy. It must still name the same original job and chunk.
 * Network submission and upload-grant allocation occur outside this transaction.
 * @param input - The owned step and candidate first request.
 * @returns The durable request and its paired pending or already recorded expense.
 * @throws {Error} When ownership, immutable identity, configuration or persistence fails.
 */
export async function openMiniToolPlanJob(input: OpenMiniToolPlanJobInput): Promise<OpenMiniToolPlanJobResult> {
  const proposed = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolConsumptionTask(proposed.taskId, tx);
    if (!task || task.source !== "mini_tool") throw new Error("Planned mini-tool job has no owning task");
    const step = await upstreamStepRepo.getStepForConsumption(task.id, proposed.stepId, tx);
    if (!step || step.kind !== "container_job") throw new Error("Planned mini-tool job has no owning container step");
    if (step.output.miniToolPlanJob !== undefined) {
      const request = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
      const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
      const identity = consumption.identity;
      if (request.jobId !== proposed.request.jobId || identity.kind !== "container" ||
        identity.jobId !== request.jobId || identity.containerClass !== request.containerClass ||
        identity.chunkIndex !== proposed.chunkIndex || step.endpoint !== request.containerClass) {
        throw new Error("Planned mini-tool job identity cannot be replaced");
      }
      return { request, consumption };
    }
    const request = proposed.request;
    if (step.status !== "pending" || step.endpoint !== request.containerClass) {
      throw new Error("Planned mini-tool job requires its original pending class step");
    }
    const config = getMiniToolsConfig();
    const configuredSize = config.classes[request.containerClass];
    if (!configuredSize) throw new Error("Planned mini-tool class is not configured");
    const size = { vcpu: configuredSize.vcpu, memory_gib: configuredSize.memory_gib, disk_gb: configuredSize.disk_gb };
    const containerPricing = {
      configVersion: await hashMiniToolValue({ schemaVersion: 1, containerClass: request.containerClass, size, prices: config.prices }),
      size, prices: config.prices,
    };
    await upstreamStepRepo.storeMiniToolPlanJob(task.id, step.id, request, tx);
    const consumption = await openMiniToolConsumption({
      taskId: task.id, stepId: step.id,
      identity: { kind: "container", jobId: request.jobId, containerClass: request.containerClass, chunkIndex: proposed.chunkIndex },
      chargeTo: proposed.chargeTo, creditMultiplier: env.CREDIT_MULTIPLIER, containerPricing,
    }, tx);
    return { request, consumption };
  });
}
