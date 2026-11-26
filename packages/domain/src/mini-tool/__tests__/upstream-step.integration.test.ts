// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore } from "@breatic/core";
import type { MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, type MiniToolPlanJobRequest } from "@breatic/shared";
import { recordMiniToolStepResult, openMiniToolPlanJob, type MiniToolStepResultParser } from "@domain/index.js";

const DEADLINE = 4070908800000;
const ERROR = { code: "provider_failed", detail: "Original diagnostic" };
const SIBLING = { original: true, rows: [1, { nested: "kept" }] };
const MANIFEST = { outputs: [{ outputIndex: 8, canonicalURL: "https://assets.test.invalid/old.mp4" }] };
let pg: ReturnType<typeof createPgClient>;

interface Fixture { taskId: string; stepId: string; userId: string; nodeId: string }
interface Consumption {
  schemaVersion: 1; consumptionKey: string; identity: MiniToolConsumptionIdentity;
  state: "pending" | "known" | "recorded"; chargeTo: "user" | "platform"; creditMultiplier: number;
  costUsd: number | null; costSource: "generation_lookup" | "computed" | null; raw: unknown; credits: number | null; containerPricing: unknown;
}
interface Attempt {
  attemptId: string; preparedAt: string; requestFingerprint: string;
  resolution: { kind: "unresolved" | "identity" | "rejected" | "not_sent"; predictionId?: string; error?: unknown };
}
interface Owner {
  schemaVersion: 1;
  scope: { taskId: string; stepId: string; kind: string; endpoint: string; itemIndex: number | null };
  deadlineAt: number; requestBody: unknown; requestFingerprint: string; chargeTo: "user" | "platform"; creditMultiplier: number;
  attempts: Attempt[]; result: { outcome: "done" | "failed"; result: unknown; error: unknown } | null;
  error: unknown; conflicts: { kind: string; attemptId?: string; canonicalId?: string; candidateId?: string; result?: unknown }[];
}
interface Snapshot {
  task: { status: string; result: { manifest: unknown; analysis: unknown; other: unknown; settlement?: { version: number; state: string; consumptionSetComplete?: boolean; pendingConsumptionKeys: string[]; leaseToken: string | null; leaseUntil: string | null } }; params: unknown; billed_at: string | null; billed_credits: number | null };
  step: { status: string; prediction_id: string | null; output: { sibling: unknown; miniToolStep?: Owner; miniToolConsumption?: Consumption; miniToolPlanJob?: MiniToolPlanJobRequest }; inline_cost_usd: number };
  node: unknown; usage: { operation_key: string; credits: string }[];
}

beforeAll(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "7", PAYMENT_ENABLED: "false" });
  pg = createPgClient(inject("DATABASE_URL"), { name: "planned-step-oracle", max: 5 });
});
afterAll(async () => { await pg.end(); });

/** Seed an independent pending container step without invoking the owner under test.
 * @throws {Error} When actual fixture SQL fails.
 */
async function seed(kind: "container_job" = "container_job"): Promise<Fixture> {
  const taskId = crypto.randomUUID(); const stepId = crypto.randomUUID(); const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID(); const projectId = crypto.randomUUID(); const spaceId = crypto.randomUUID(); const nodeId = crypto.randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`step-${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`s-${studioId}`},'team','Step')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`p-${projectId}`},'Step')`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result)
    VALUES (${taskId},${userId},${projectId},${spaceId},'mini_tool_analysis','append','mini_tool','running',
      ${pg.json({ frozen: true, deadlineAt: DEADLINE })},${pg.json({ manifest: MANIFEST, analysis: { preserved: true }, other: SIBLING })})`;
  await pg`INSERT INTO node_tasks (id,project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id)
    VALUES (${nodeId},${projectId},${spaceId},${crypto.randomUUID()},'generation','mini_tool','running',${userId},7200000,'analysis',${taskId})`;
  await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output)
    VALUES (${stepId},${taskId},0,${kind},${"MiniToolContainerStd1"},'pending',${pg.json({ sibling: SIBLING })})`;
  return { taskId, stepId, userId, nodeId };
}

/** Read actual JSONB and the independent node, fee and parent facts.
 * @throws {Error} When a fixture has disappeared.
 */
async function snapshot(f: Fixture): Promise<Snapshot> {
  const [task] = await pg<Snapshot["task"][]>`SELECT status,result,params,billed_at::text,billed_credits FROM tasks WHERE id=${f.taskId}`;
  const [step] = await pg<Snapshot["step"][]>`SELECT status,prediction_id,output,inline_cost_usd FROM task_upstream_steps WHERE id=${f.stepId}`;
  const [node] = await pg`SELECT status,started_at::text,settled_at::text,budget_ms FROM node_tasks WHERE id=${f.nodeId}`;
  const usage = await pg<Snapshot["usage"]>`SELECT operation_key,credits::text FROM agent_usage_records WHERE actor_user_id=${f.userId} ORDER BY id`;
  if (!task || !step || !node) throw new Error("Step fixture disappeared");
  return { task, step, node, usage };
}

/** Keep original computation, node and unrelated JSON facts outside the step owner.
 * @throws {Error} When an invariant differs.
 */
function preserved(before: Snapshot, after: Snapshot): void {
  expect(after.task.status).toBe(before.task.status); expect(after.task.params).toEqual(before.task.params);
  expect(after.task.billed_at).toBe(before.task.billed_at); expect(after.task.billed_credits).toBe(before.task.billed_credits);
  expect(after.task.result.manifest).toEqual(MANIFEST); expect(after.task.result.analysis).toEqual(before.task.result.analysis);
  expect(after.task.result.other).toEqual(SIBLING); expect(after.step.output.sibling).toEqual(SIBLING); expect(after.node).toEqual(before.node);
  expect(after.step.inline_cost_usd).toBe(before.step.inline_cost_usd);
}

/** Prepare a container-only fixture through its existing request and expense owner.
 * @throws {Error} When the complete plan opening fails.
 */
// A job frame recipe names a grid frame of the frozen grid, the tool source and its PNG target (frames-split §7.16).
async function container(): Promise<{ f: Fixture; plan: MiniToolPlanJobRequest; identity: MiniToolConsumptionIdentity; parser: MiniToolStepResultParser }> {
  const f = await seed("container_job"); const inputId = crypto.randomUUID();
  const plan = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId: `task:${f.taskId}:chunk:0`, containerClass: "MiniToolContainerStd1", deadlineAt: DEADLINE,
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, inputs: [{ inputId, storageKey: "source/video.mp4" }],
    outputs: [{ outputIndex: 8, storageKey: "issued/frame-8.png", contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 4, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }] });
  await openMiniToolPlanJob({ taskId: f.taskId, stepId: f.stepId, chunkIndex: 0, chargeTo: "platform", request: plan });
  return { f, plan, identity: { kind: "container", containerClass: plan.containerClass, jobId: plan.jobId, chunkIndex: 0 }, parser: { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(plan, value) } };
}

describe("operation-typed results keep execution, plans and expenses separate", () => {
  it.each([false, true])("keeps the full container plan and failed completed subset with missingCPU=%s", async (missingCpu) => {
    const { f, plan, identity, parser } = await container(); const before = await snapshot(f);
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: missingCpu ? null : { wallMs: 1234, cpuUsec: 900 }, outputs: [{ outputIndex: 8, storageKey: "issued/frame-8.png", sha256: "a".repeat(64), sizeBytes: 8, contentType: "image/png", width: 2, height: 3, durationSeconds: null, cover: null, upright: null }] };
    await recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report, error: ERROR }, parser); const after = await snapshot(f);
    expect(after.step.status).toBe("failed"); expect(after.step.prediction_id).toBeNull(); expect(after.step.output.miniToolPlanJob).toEqual(plan); expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.step.output.miniToolStep!.result!.result).toEqual(report); expect(after.step.output.miniToolStep!.error).toEqual(ERROR); expect(after.usage).toEqual([]); preserved(before, after);
  });
});

describe("planned step contract branches isolated from earlier terminal shortcuts", () => {
  it("refuses a parsed failed container report without its required failure diagnostic", async () => {
    const { f, identity, parser } = await container(); const before = await snapshot(f);
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: { wallMs: 1234, cpuUsec: 900 }, outputs: [] };
    expect(parser.parse(report)).toEqual(report);
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report }, parser)).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it("replays the same done report without replacing the first canonical result, and keeps a distinct one as a conflict", async () => {
    const { f, identity, parser } = await container();
    const report = (wallMs: number): unknown => ({ schemaVersion: 2, state: "done", usage: { wallMs, cpuUsec: 900 }, outputs: [{ outputIndex: 8, storageKey: "issued/frame-8.png", sha256: "a".repeat(64), sizeBytes: 8, contentType: "image/png", width: 2, height: 3, durationSeconds: null, cover: null, upright: null }] });
    const save = (value: unknown): Promise<unknown> => recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "done", result: value }, parser);
    await save(report(1234)); const first = await snapshot(f);
    expect(first.step.status).toBe("done");
    await save(report(1234)); expect(await snapshot(f)).toEqual(first);
    await expect(save(report(4321))).rejects.toThrow(); const after = await snapshot(f);
    expect(after.step.output.miniToolStep!.result).toEqual(first.step.output.miniToolStep!.result);
    expect(after.step.output.miniToolStep!.conflicts).toHaveLength(1);
    expect(after.step.output.miniToolConsumption).toEqual(first.step.output.miniToolConsumption); preserved(first, after);
  });

  it("refuses a result for an existing non-mini-tool parent or a missing parent", async () => {
    const { f, identity, parser } = await container();
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: null, outputs: [] };
    await pg`UPDATE tasks SET source='canvas' WHERE id=${f.taskId}`;
    const before = await snapshot(f);
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report, error: ERROR }, parser)).rejects.toThrow();
    await expect(recordMiniToolStepResult({ taskId: crypto.randomUUID(), stepId: f.stepId, identity, outcome: "failed", result: report, error: ERROR }, parser)).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });
});
