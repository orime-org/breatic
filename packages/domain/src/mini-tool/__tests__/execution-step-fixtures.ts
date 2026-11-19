// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import { getNodeTaskConfig } from "@breatic/core";
import { miniToolConsumptionKey, type MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import {
  beginMiniToolStepAttempt, claimMiniToolSettlement, recordMiniToolStepIdentity, taskRepo, upstreamStepRepo,
  type MiniToolExecutionCompletion,
} from "@domain/index.js";
import { executionSnapshot, storeExecutionFixture, type ExecutionFixture, type FixturePg } from "./execution-lifecycle-fixtures.js";

// Steps on a seeded execution through the domain's own entries; only domain tests import this file, since the
// integration-tests package reaches the seed in execution-lifecycle-fixtures.ts without the @domain alias.
export const EXECUTION_ERROR = { code: "registration_failed", message: "Original registration failure" };
export const PREDICTION_ID = "planned-original-prediction";

/** Build the independently prescribed complete indexed observation. */
export function executionCompletion(f: ExecutionFixture, failed = false, expectedVersion = 0): MiniToolExecutionCompletion {
  return { planFingerprint: f.plan.planFingerprint, expectedVersion, error: failed ? EXECUTION_ERROR : null,
    outputs: [{ ...f.plan.outputs[0]!, result: failed ? { status: "failed", error: EXECUTION_ERROR } : f.registered, late: false }] };
}
/** Read the public JSON without going through the public reader.
 * @throws {Error} On a fixture SQL failure.
 */
export async function publicExecutionRecord(pg: FixturePg, f: ExecutionFixture): Promise<MiniToolExecutionRecord> {
  const row = await executionSnapshot(pg, f); return row.result.miniToolExecution as MiniToolExecutionRecord;
}
/** Independently seed a terminal namespace so a late CAS test does not require start/finish to be GREEN.
 * @throws {Error} On a fixture SQL failure.
 */
export async function terminalExecution(pg: FixturePg, f: ExecutionFixture, failed = false): Promise<MiniToolExecutionRecord> {
  const held = await publicExecutionRecord(pg, f);
  const r: MiniToolExecutionRecord = { ...held, status: failed ? "failed" : "completed", resultVersion: 1,
    outputs: executionCompletion(f, failed).outputs, error: failed ? EXECUTION_ERROR : null };
  await pg`UPDATE tasks SET status=${r.status},error_message=${failed ? EXECUTION_ERROR.code : null},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
  await storeExecutionFixture(pg, f, r); return r;
}
/** Prepare a real durable intent and optionally its real pending expense.
 * @throws {Error} When an original SQL persistence owner fails.
 */
export async function executionIdentity(f: ExecutionFixture, chargeTo: "user" | "platform" = "user", save = true): Promise<{ stepId: string; attemptId: string; key: string; identity: { kind: "provider"; provider: "wavespeed"; predictionId: string } }> {
  const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]);
  if (!s) throw new Error("Fixture step disappeared"); const attemptId = randomUUID();
  const task = await taskRepo.getMiniToolExecutionTask(f.taskId); if (!task) throw new Error("Missing fixture task");
  await beginMiniToolStepAttempt({ taskId: f.taskId, stepId: s.id, attemptId, deadlineAt: task.createdAt.getTime() + getNodeTaskConfig().default_budget_ms, requestBody: { ...f.plan.body }, chargeTo });
  const upstream = { kind: "provider" as const, provider: "wavespeed" as const, predictionId: PREDICTION_ID };
  if (save) await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: s.id, attemptId, predictionId: PREDICTION_ID });
  return { stepId: s.id, attemptId, key: await miniToolConsumptionKey({ taskId: f.taskId, stepId: s.id, identity: upstream }), identity: upstream };
}
/** Claim the existing database cycle, with no upstream query or fabricated lease.
 * @throws {Error} If the fixture's actual cycle is not claimable.
 */
export async function claimExecutionSettlement(pg: FixturePg, f: ExecutionFixture): Promise<NonNullable<Awaited<ReturnType<typeof claimMiniToolSettlement>>>> {
  const row = await executionSnapshot(pg, f); const period = row.result.settlement as { version: number };
  const c = await claimMiniToolSettlement({ taskId: f.taskId, settlementVersion: period.version });
  if (!c) throw new Error("Fixture settlement was not claimed"); return c;
}
