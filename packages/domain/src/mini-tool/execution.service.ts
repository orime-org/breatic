// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ConsentSnapshot, TaskEntity } from "@breatic/shared";
import type { MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import type { AcceptedMiniToolExecution } from "@domain/mini-tool/execution-admission.service.js";

/** Queue transport carries a discriminator and task identity, never a second frozen plan. */
export interface MiniToolExecutionJob {
  taskId: string; source: "mini_tool"; executionKind: "planned"; analyticsConsent?: ConsentSnapshot;
}
/** Original SQL parent, complete frozen plan and its current public projection. */
export interface MiniToolExecution {
  task: TaskEntity; execution: AcceptedMiniToolExecution; record: MiniToolExecutionRecord;
}
/** A complete indexed observation, with the original media CAS and actual call-set proof. */
export interface MiniToolExecutionCompletion {
  planFingerprint: string; expectedVersion: number; outputs: MiniToolExecutionRecord["outputs"];
  error: MiniToolExecutionRecord["error"]; consumptionSet: "complete" | "uncertain";
}
/**
 * Enter the SQL-owned planned lane before any provider or transfer boundary.
 * @param _taskId - The original accepted SQL task.
 * @param _jobId - The queue identity picking up that task.
 * @throws {Error} Until the execution lifecycle owner is implemented.
 */
export async function startMiniToolExecution(_taskId: string, _jobId: string): Promise<MiniToolExecution> {
  throw new Error("Planned execution start is not implemented");
}
/**
 * Commit a complete indexed result and its call-set proof under the original task lock.
 * @param _taskId - The original accepted SQL task.
 * @param _completion - The complete indexed observation and closure proof.
 * @throws {Error} Until the execution lifecycle owner is implemented.
 */
export async function finishMiniToolExecution(_taskId: string, _completion: MiniToolExecutionCompletion): Promise<MiniToolExecution> {
  throw new Error("Planned execution completion is not implemented");
}
/**
 * Read only original tasks and current project membership for a collaborator.
 * @param _projectId - The Project in the route path.
 * @param _runId - The immutable execution run.
 * @param _userId - The currently authenticated collaborator.
 * @throws {Error} Until the project-scoped execution reader is implemented.
 */
export async function getMiniToolExecution(_projectId: string, _runId: string, _userId: string): Promise<MiniToolExecutionRecord> {
  throw new Error("Planned execution read is not implemented");
}
