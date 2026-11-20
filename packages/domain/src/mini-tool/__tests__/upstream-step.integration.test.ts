// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import crypto from "node:crypto";
import fc from "fast-check";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore } from "@breatic/core";
import type { MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, type MiniToolPlanJobRequest } from "@breatic/shared";
import {
  recordMiniToolStepResult, openMiniToolPlanJob, recordMiniToolConsumption, markStepSending, endMiniToolModelStep,
  type MiniToolStepResultParser,
} from "@domain/index.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

const DEADLINE = 4070908800000;
const RESULT = { schemaVersion: 1, kind: "tracking_observation", frames: [{ ordinal: 0, counts: "4" }] };
const ERROR = { code: "provider_failed", detail: "Original diagnostic" };
const SIBLING = { original: true, rows: [1, { nested: "kept" }] };
const MANIFEST = { outputs: [{ outputIndex: 8, canonicalURL: "https://assets.test.invalid/old.mp4" }] };
const RESULT_SCHEMA = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("tracking_observation"), frames: z.array(z.strictObject({ ordinal: z.number().int().nonnegative(), counts: z.string() })) });
const PARSER: MiniToolStepResultParser = { kind: "generate", parse: (value) => RESULT_SCHEMA.parse(value) };
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

/** Seed an independent pending provider call without invoking the owner under test.
 * @throws {Error} When actual fixture SQL fails.
 */
async function seed(kind: "generate" | "container_job" = "generate"): Promise<Fixture> {
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
    VALUES (${stepId},${taskId},0,${kind},${kind === "generate" ? "wavespeed-ai/sam3-video-rle" : "MiniToolContainerStd1"},'pending',${pg.json({ sibling: SIBLING })})`;
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

/** End the model step returned through the real public entries: its send is marked, then its answer and costs are
 * written once (inner#1306 §11.4).
 * @param cost - The step's one billed cost: still pending on its lookup, or already known.
 * @throws {Error} When the send or the end cannot be saved.
 */
async function identify(f: Fixture, cost: "pending" | "known" = "pending"): Promise<void> {
  await markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed");
  await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "returned", link: "https://provider.test.invalid/out.json" },
    costs: [cost === "known" ? { state: "known", usd: 0.2, source: "billing" } : { state: "pending", lookup: { upstream: "wavespeed", predictionId: "prediction-original" } }], servedBy: "wavespeed" });
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

/** Save a provider-specific parsed result, with no network or mask algorithm involved.
 * @throws {Error} When schema, identity or persistence fails.
 */
async function done(f: Fixture, result: unknown = RESULT): Promise<void> {
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity: { kind: "provider", stepId: f.stepId }, outcome: "done", result }, PARSER);
}

/** Hold a real task row until both independently observed contenders have queued.
 * @throws {Error} When a contender bypasses the task lock or the gated operation fails.
 */
async function gated(f: Fixture, first: () => Promise<unknown>, second?: () => Promise<unknown>): Promise<void> {
  let release!: () => void; let entered!: () => void;
  const holding = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; entered(); await holding; });
  await ready;
  let one: Promise<unknown> | undefined; let two: Promise<unknown> | undefined;
  try {
    one = first(); one.catch(() => undefined);
    await waitUntilBlockedOn(pg, ["tasks", "for update"], 1);
    if (second) { two = second(); two.catch(() => undefined); await waitUntilBlockedOn(pg, ["tasks", "for update"], 2); }
  } finally { release(); await gate; }
  await one; await two;
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
  it("saves a complete parsed result while fee state stays pending and source facts remain unchanged", async () => {
    const f = await seed(); await identify(f); const before = await snapshot(f); await done(f); const after = await snapshot(f);
    expect(after.step.status).toBe("done"); expect(after.step.output.miniToolStep!.result).toEqual({ outcome: "done", result: RESULT, error: null }); expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption); expect(after.usage).toEqual([]); preserved(before, after);
    const [shape] = await pg`SELECT jsonb_typeof(output->'miniToolStep') AS owner,jsonb_typeof(output->'sibling') AS sibling,jsonb_typeof(output->'miniToolStep'->'result'->'result'->'frames') AS frames FROM task_upstream_steps WHERE id=${f.stepId}`; expect(shape).toEqual({ owner: "object", sibling: "object", frames: "array" });
  });
  it("rejects malformed results, a mismatched kind and unowned patch fields without partial writes", async () => {
    const f = await seed(); await identify(f); const before = await snapshot(f);
    await expect(done(f, { ...RESULT, frames: "not-frames" })).rejects.toThrow();
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity: before.step.output.miniToolConsumption!.identity, outcome: "done", result: RESULT }, { ...PARSER, kind: "container_job" })).rejects.toThrow();
    await expect(done(f, { ...RESULT, miniToolConsumption: { state: "pending" }, miniToolPlanJob: { replaced: true } })).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
  });
  it("requires the model step's end before saving an operation result", async () => {
    const f = await seed(); await markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed"); const before = await snapshot(f); await expect(done(f)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "returned", link: "https://provider.test.invalid/out.json" }, costs: [], servedBy: "wavespeed" });
    await done(f); expect((await snapshot(f)).step.status).toBe("done");
  });
  it("refuses a result under another step's identity", async () => {
    const f = await seed(); await identify(f); const before = await snapshot(f);
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity: { kind: "provider", stepId: crypto.randomUUID() }, outcome: "done", result: RESULT }, PARSER)).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });
  it("replays the same result without replacing the first canonical result or incrementing costs", async () => {
    const f = await seed(); await identify(f); await done(f); const first = await snapshot(f); await done(f); expect(await snapshot(f)).toEqual(first);
    await expect(done(f, { ...RESULT, frames: [{ ordinal: 0, counts: "5" }] })).rejects.toThrow(); const after = await snapshot(f); expect(after.step.output.miniToolStep!.result).toEqual(first.step.output.miniToolStep!.result); expect(after.step.output.miniToolConsumption).toEqual(first.step.output.miniToolConsumption);
  });
  it.each([false, true])("keeps the full container plan and failed completed subset with missingCPU=%s", async (missingCpu) => {
    const { f, plan, identity, parser } = await container(); const before = await snapshot(f);
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: missingCpu ? null : { wallMs: 1234, cpuUsec: 900 }, outputs: [{ outputIndex: 8, storageKey: "issued/frame-8.png", sha256: "a".repeat(64), sizeBytes: 8, contentType: "image/png", width: 2, height: 3, durationSeconds: null, cover: null, upright: null }] };
    await recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report, error: ERROR }, parser); const after = await snapshot(f);
    expect(after.step.status).toBe("failed"); expect(after.step.prediction_id).toBeNull(); expect(after.step.output.miniToolPlanJob).toEqual(plan); expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.step.output.miniToolStep!.result!.result).toEqual(report); expect(after.step.output.miniToolStep!.error).toEqual(ERROR); expect(after.usage).toEqual([]); preserved(before, after);
  });
  it.each([false, true])("merges typed result and actual usage in both observed lock orders, resultFirst=%s", async (resultFirst) => {
    const f = await seed(); await identify(f, "known"); const before = await snapshot(f); const identity = before.step.output.miniToolConsumption!.identity;
    const record = (): Promise<unknown> => recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity });
    if (resultFirst) await gated(f, () => done(f), record); else await gated(f, record, () => done(f));
    const after = await snapshot(f); expect(after.step.status).toBe("done"); expect(after.step.output.miniToolStep!.result!.result).toEqual(RESULT); expect(after.step.output.miniToolConsumption).toMatchObject({ state: "recorded", known: 0.2 }); expect(after.usage).toHaveLength(1); preserved(before, after);
  });
  it("keeps result persistence idempotent for arbitrary repeated pickup counts", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (repeats) => {
      const f = await seed(); await identify(f); await done(f); const first = await snapshot(f);
      for (let i = 0; i < repeats; i += 1) await done(f);
      expect(await snapshot(f)).toEqual(first);
    }), { numRuns: 8 });
  });
});

describe("planned step contract branches isolated from earlier terminal shortcuts", () => {
  it("persists a distinct valid result conflict while keeping the first result and expense", async () => {
    const f = await seed(); await identify(f); await done(f); const before = await snapshot(f);
    const candidate = { schemaVersion: 1, kind: "tracking_observation", frames: [{ ordinal: 0, counts: "5" }] };
    expect(PARSER.parse(candidate)).toEqual(candidate);
    await expect(done(f, candidate)).rejects.toThrow(); const after = await snapshot(f);
    expect(after.step.status).toBe("done");
    expect(after.step.output.miniToolStep!.result).toEqual(before.step.output.miniToolStep!.result);
    expect(after.step.output.miniToolStep!.conflicts).toEqual([{ kind: "result", result: candidate }]);
    expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.task).toEqual(before.task); expect(after.usage).toEqual(before.usage); preserved(before, after);
    await expect(done(f, candidate)).rejects.toThrow(); expect(await snapshot(f)).toEqual(after);
  });

  it("refuses the result for an existing non-mini-tool parent", async () => {
    const f = await seed(); await identify(f); await pg`UPDATE tasks SET source='canvas' WHERE id=${f.taskId}`;
    const before = await snapshot(f); await expect(done(f)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
    const [parent] = await pg`SELECT source FROM tasks WHERE id=${f.taskId}`; expect(parent?.source).toBe("canvas");
  });

  it("refuses the result for a missing parent without touching another task's step", async () => {
    const f = await seed(); await identify(f); const before = await snapshot(f); const missing = crypto.randomUUID();
    await expect(done({ ...f, taskId: missing })).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
    const [remaining] = await pg`SELECT count(*)::int AS count FROM tasks WHERE id=${missing}`; expect(remaining?.count).toBe(0);
  });

  it("refuses a parsed failed container report without its required failure diagnostic", async () => {
    const { f, identity, parser } = await container(); const before = await snapshot(f);
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: { wallMs: 1234, cpuUsec: 900 }, outputs: [] };
    expect(parser.parse(report)).toEqual(report);
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report }, parser)).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["known", "recorded"] as const)("keeps the closed call set and active lookup claim on a same-result %s replay", async (state) => {
    const f = await seed(); await identify(f, "known"); await done(f); const identity = (await snapshot(f)).step.output.miniToolConsumption!.identity;
    if (state === "recorded") await recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity });
    const open = await snapshot(f); const claim = crypto.randomUUID();
    await pg`UPDATE tasks SET status='completed',result=jsonb_set(result,'{settlement}',(result->'settlement') || ${pg.json({ state: "checking", consumptionSetComplete: true, leaseToken: claim, leaseUntil: "2099-01-01T00:00:00.000000Z" })}) WHERE id=${f.taskId}`;
    const before = await snapshot(f); expect(before.step.status).toBe("done"); expect(before.step.output.miniToolConsumption!.state).toBe(state);
    expect(before.task.result.settlement).toMatchObject({ state: "checking", consumptionSetComplete: true, leaseToken: claim }); expect(before.usage).toEqual(open.usage);
    await done(f); expect(await snapshot(f)).toEqual(before);
  });
});
