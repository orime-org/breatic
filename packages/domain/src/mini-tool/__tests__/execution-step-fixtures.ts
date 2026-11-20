// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import { miniToolPlanJobRequestSchema } from "@breatic/shared";
import { miniToolConsumptionKey, type MiniToolConsumptionIdentity, type MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import {
  claimMiniToolSettlement, confirmMiniToolConsumption, openMiniToolPlanJob, upstreamStepRepo,
  type MiniToolExecutionCompletion,
} from "@domain/index.js";
import { executionSnapshot, storeExecutionFixture, type ExecutionFixture, type FixturePg } from "./execution-lifecycle-fixtures.js";

// Steps on a seeded execution through the domain's own entries; only domain tests import this file, since the
// integration-tests package reaches the seed in execution-lifecycle-fixtures.ts without the @domain alias.
export const EXECUTION_ERROR = { code: "registration_failed", message: "Original registration failure" };

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
/** Open the fixture's one container job, its consumption pending on its report (frames-split §5.4).
 * @throws {Error} When an original SQL persistence owner fails.
 */
export async function executionIdentity(f: ExecutionFixture): Promise<{ stepId: string; key: string; identity: MiniToolConsumptionIdentity }> {
  const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "container_job", endpoint: "MiniToolContainerStd4", itemIndex: 0 }]);
  if (!s) throw new Error("Fixture step disappeared");
  const inputId = randomUUID();
  const request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId: `${f.taskId}:batch:0:a1`, containerClass: "MiniToolContainerStd4", deadlineAt: 4070908800000,
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, inputs: [{ inputId, storageKey: "video/source.mp4" }],
    outputs: [{ outputIndex: 0, storageKey: `planned/${f.taskId}/0.mp4`, contentType: "video/mp4", recipe: { kind: "segment", inputId,
      grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 },
      source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frames: { start: 0, end: 96 },
      target: { width: 960, height: 540, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" }, audio: true } }] });
  const { consumption } = await openMiniToolPlanJob({ taskId: f.taskId, stepId: s.id, chunkIndex: 0, chargeTo: f.plan.chargeTo, request });
  return { stepId: s.id, key: await miniToolConsumptionKey({ taskId: f.taskId, stepId: s.id, identity: consumption.identity }), identity: consumption.identity };
}
/** Confirm the container job's computed cost under a current settlement lease, as a looked-up report does.
 * @throws {Error} When the confirmation cannot be saved.
 */
export async function confirmExecutionCost(f: ExecutionFixture, i: { stepId: string; identity: MiniToolConsumptionIdentity }, claim: { version: number; leaseToken: string }, costUsd: number): Promise<void> {
  await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim, costUsd, costSource: "computed", raw: { wallMs: 1000, cpuUsec: null } });
}
/** Claim the existing database cycle, with no upstream query or fabricated lease; the cycle is made due first.
 * @throws {Error} If the fixture's actual cycle is not claimable.
 */
export async function claimExecutionSettlement(pg: FixturePg, f: ExecutionFixture): Promise<NonNullable<Awaited<ReturnType<typeof claimMiniToolSettlement>>>> {
  await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,nextAttemptAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
    WHERE id=${f.taskId} AND result ? 'settlement' AND result->'settlement'->>'state'='waiting'`;
  const row = await executionSnapshot(pg, f); const period = row.result.settlement as { version: number };
  const c = await claimMiniToolSettlement({ taskId: f.taskId, settlementVersion: period.version });
  if (!c) throw new Error("Fixture settlement was not claimed"); return c;
}
