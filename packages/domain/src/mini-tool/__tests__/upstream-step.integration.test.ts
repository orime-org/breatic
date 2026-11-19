// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import crypto from "node:crypto";
import fc from "fast-check";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore } from "@breatic/core";
import { miniToolConsumptionKey, type MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, type MiniToolPlanJobRequest } from "@breatic/shared";
import {
  beginMiniToolStepAttempt, recordMiniToolStepIdentity, recordMiniToolStepResult, failMiniToolStep,
  openMiniToolPlanJob, completeMiniToolConsumptionSet, recordMiniToolConsumption,
  type BeginMiniToolStepAttemptInput, type MiniToolStepResultParser,
} from "@domain/index.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

const DEADLINE = 4070908800000;
const BODY = { apply_mask: false, video: "https://assets.test.invalid/normalized.mp4", box_prompts: [{ frame_index: 4, x: 10, y: 20, width: 30, height: 40 }] };
const RESULT = { schemaVersion: 1, kind: "tracking_observation", frames: [{ ordinal: 0, counts: "4" }] };
const ERROR = { code: "provider_failed", detail: "Original diagnostic" };
const SIBLING = { original: true, rows: [1, { nested: "kept" }] };
const MANIFEST = { outputs: [{ outputIndex: 8, canonicalURL: "https://assets.test.invalid/old.mp4" }] };
const RESULT_SCHEMA = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("tracking_observation"), frames: z.array(z.strictObject({ ordinal: z.number().int().nonnegative(), counts: z.string() })) });
const PARSER: MiniToolStepResultParser = { kind: "generate", parse: (value) => RESULT_SCHEMA.parse(value) };
let pg: ReturnType<typeof createPgClient>;

interface Fixture { taskId: string; stepId: string; userId: string; nodeId: string; input: BeginMiniToolStepAttemptInput }
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
  return { taskId, stepId, userId, nodeId, input: { taskId, stepId, attemptId: crypto.randomUUID(), deadlineAt: DEADLINE, requestBody: structuredClone(BODY), chargeTo: "user" } };
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

/** Accept the first fixed prediction through the real public persistence entry.
 * @throws {Error} When a preparation or receipt cannot be saved.
 */
async function identify(f: Fixture, predictionId = "prediction-original"): Promise<void> {
  await beginMiniToolStepAttempt(f.input);
  await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId });
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
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity: { kind: "provider", provider: "wavespeed", predictionId: "prediction-original" }, outcome: "done", result }, PARSER);
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

/** Force an actual write failure at a selected transaction boundary.
 * @throws {Error} When trigger management or the tested SQL fails.
 */
async function failTaskWrite(f: Fixture, run: () => Promise<unknown>): Promise<void> {
  const name = `step_red_${crypto.randomUUID().replaceAll("-", "")}`;
  await pg.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result ? 'settlement' THEN RAISE EXCEPTION 'step task write failed'; END IF; RETURN NEW; END $$`);
  await pg.unsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await expect(run()).rejects.toMatchObject({ cause: { message: expect.stringContaining("step task write failed") } }); }
  finally { await pg.unsafe(`DROP TRIGGER ${name} ON tasks`); await pg.unsafe(`DROP FUNCTION ${name}()`); }
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

describe("planned upstream intent and canonical identity persistence", () => {
  it("persists prepared intent and frozen request before permitting a POST", async () => {
    const f = await seed(); const before = await snapshot(f); let posts = 0;
    const opened = await beginMiniToolStepAttempt(f.input);
    if (opened.shouldSubmit) { const atPost = await snapshot(f); expect(atPost.step.output.miniToolStep!.attempts[0]!.attemptId).toBe(f.input.attemptId); posts += 1; }
    const after = await snapshot(f); expect(posts).toBe(1); expect(opened.attempt).toMatchObject({ attemptId: f.input.attemptId, resolution: { kind: "unresolved" } });
    expect(opened.attempt!.preparedAt).toMatch(/^\d{4}-\d\d-\d\dT.*\.\d{6}Z$/);
    expect(after.step.output.miniToolStep).toMatchObject({ schemaVersion: 1, deadlineAt: DEADLINE, requestBody: BODY, chargeTo: "user", creditMultiplier: 7, scope: { taskId: f.taskId, stepId: f.stepId, kind: "generate", endpoint: "wavespeed-ai/sam3-video-rle" } });
    expect(after.step.status).toBe("pending"); expect(after.step.prediction_id).toBeNull(); expect(after.step.output.miniToolConsumption).toBeUndefined(); expect(after.usage).toEqual([]); preserved(before, after);
  });
  it("does not permit POST when the pre-submit persistence transaction rolls back", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const second = { ...f.input, attemptId: crypto.randomUUID() }; const before = await snapshot(f); let posts = 0;
    const name = `intent_red_${crypto.randomUUID().replaceAll("-", "")}`;
    await pg.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.stepId}'::uuid THEN RAISE EXCEPTION 'intent failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON task_upstream_steps FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { await expect((async () => { const opened = await beginMiniToolStepAttempt(second); if (opened.shouldSubmit) posts += 1; })()).rejects.toMatchObject({ cause: { message: expect.stringContaining("intent failed") } }); }
    finally { await pg.unsafe(`DROP TRIGGER ${name} ON task_upstream_steps`); await pg.unsafe(`DROP FUNCTION ${name}()`); }
    expect(posts).toBe(0); expect(await snapshot(f)).toEqual(before);
  });
  it("replays one intent without a second POST and preserves its original policy and deadline", async () => {
    const f = await seed(); const first = await beginMiniToolStepAttempt(f.input); const before = await snapshot(f);
    const replay = await beginMiniToolStepAttempt({ ...f.input, deadlineAt: DEADLINE + 99999, chargeTo: "platform" });
    expect(first.shouldSubmit).toBe(true); expect(replay.shouldSubmit).toBe(false); expect(replay.attempt).toEqual(first.attempt); expect(await snapshot(f)).toEqual(before);
  });
  it("keeps all uncertain attempts after a no-ID retry rather than claiming no call occurred", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const second = { ...f.input, attemptId: crypto.randomUUID() };
    expect((await beginMiniToolStepAttempt(second)).shouldSubmit).toBe(true);
    const at = await snapshot(f); expect(at.step.output.miniToolStep!.attempts.map((a) => [a.attemptId, a.resolution])).toEqual([[f.input.attemptId, { kind: "unresolved" }], [second.attemptId, { kind: "unresolved" }]]);
    expect(at.step.output.miniToolConsumption).toBeUndefined(); expect(at.usage).toEqual([]);
  });
  it("saves the first prediction, pending expense and task todo atomically", async () => {
    const f = await seed(); const before = await snapshot(f); await identify(f); const after = await snapshot(f);
    const identity = { kind: "provider", provider: "wavespeed", predictionId: "prediction-original" } as const;
    const key = await miniToolConsumptionKey({ taskId: f.taskId, stepId: f.stepId, identity });
    expect(after.step).toMatchObject({ status: "submitted", prediction_id: identity.predictionId });
    expect(after.step.output.miniToolConsumption).toMatchObject({ identity, consumptionKey: key, state: "pending", chargeTo: "user", creditMultiplier: 7, costUsd: null, raw: null, credits: null });
    expect(after.task.result.settlement).toMatchObject({ consumptionSetComplete: false, pendingConsumptionKeys: [key] });
    expect(after.step.output.miniToolStep!.attempts[0]!.resolution).toEqual({ kind: "identity", predictionId: identity.predictionId }); expect(after.usage).toEqual([]); preserved(before, after);
  });
  it("rolls back the prediction and expense when the matching task todo write fails", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const before = await snapshot(f);
    await failTaskWrite(f, () => recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }));
    expect(await snapshot(f)).toEqual(before);
  });
  it("preserves recorded expense, original policy and active lookup claim on identity replay", async () => {
    const f = await seed(); await identify(f); const key = (await snapshot(f)).step.output.miniToolConsumption!.consumptionKey;
    await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolConsumption}',(output->'miniToolConsumption') || ${pg.json({ state: "known", costUsd: 0.1, costSource: "generation_lookup", raw: { deductUsd: 0.1 }, credits: null })}) WHERE id=${f.stepId}`;
    const lease = crypto.randomUUID(); await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement}',(result->'settlement') || ${pg.json({ state: "checking", leaseToken: lease, leaseUntil: "2099-01-01T00:00:00.000000Z" })}) WHERE id=${f.taskId}`;
    const known = await snapshot(f); await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }); expect(await snapshot(f)).toEqual(known);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity: known.step.output.miniToolConsumption!.identity });
    const recorded = await snapshot(f); await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }); expect(await snapshot(f)).toEqual(recorded); expect(recorded.usage.map((u) => u.operation_key)).toEqual([key]);
  });
  it("does not authorize another attempt after a canonical identity exists", async () => {
    const f = await seed(); await identify(f); const before = await snapshot(f);
    expect((await beginMiniToolStepAttempt({ ...f.input, attemptId: crypto.randomUUID() })).shouldSubmit).toBe(false); expect(await snapshot(f)).toEqual(before);
  });
  it("rejects foreign scope and an ID without its own persisted attempt", async () => {
    const f = await seed(); const other = await seed(); await beginMiniToolStepAttempt(f.input); const before = await snapshot(f); const untouched = await snapshot(other);
    await expect(recordMiniToolStepIdentity({ taskId: f.taskId, stepId: other.stepId, attemptId: f.input.attemptId, predictionId: "foreign" })).rejects.toThrow();
    await expect(recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: crypto.randomUUID(), predictionId: "unproved" })).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before); expect(await snapshot(other)).toEqual(untouched);
  });
  it("checks scope and request fingerprint against the immutable attempt body", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const before = await snapshot(f);
    await expect(beginMiniToolStepAttempt({ ...f.input, attemptId: crypto.randomUUID(), requestBody: { ...BODY, video: "https://assets.test.invalid/replaced.mp4" } })).rejects.toThrow();
    await pg`UPDATE task_upstream_steps SET endpoint='wavespeed-ai/replaced' WHERE id=${f.stepId}`;
    await expect(recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "wrong-endpoint" })).rejects.toThrow();
    const after = await snapshot(f); expect(after.step.prediction_id).toBeNull(); expect(after.step.output).toEqual(before.step.output); expect(after.task).toEqual(before.task);
  });
  it("keeps done terminal state on same-ID replays and duplicate failures", async () => {
    const f = await seed(); await identify(f); await done(f); const before = await snapshot(f);
    await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR });
    expect(await snapshot(f)).toEqual(before); expect(before.step.status).toBe("done");
  });
  it("restores the first late ID from a real pre-terminal intent without reviving computation", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR });
    await pg`UPDATE tasks SET status='failed' WHERE id=${f.taskId}`;
    const before = await snapshot(f); await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }); const after = await snapshot(f);
    expect(after.step.status).toBe("failed"); expect(after.step.output.miniToolStep!.error).toEqual(ERROR); expect(after.step.prediction_id).toBe("prediction-original");
    expect(after.step.output.miniToolConsumption).toMatchObject({ state: "pending", costUsd: null });
    // The receipt resolves the ended analysis's last attempt, so its call set closes with it (execution design §6.12).
    expect(after.task.result.settlement).toMatchObject({ consumptionSetComplete: true }); preserved(before, after);
    expect((await beginMiniToolStepAttempt({ ...f.input, attemptId: crypto.randomUUID() })).shouldSubmit).toBe(false);
  });
  it("keeps ambiguous intent incomplete when calculation ends without any provider ID", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR }); await pg`UPDATE tasks SET status='failed' WHERE id=${f.taskId}`;
    const before = await snapshot(f); await expect(completeMiniToolConsumptionSet(f.taskId)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
  });
  it("closes the call set only after each attempt has its own verified resolution", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const second = { ...f.input, attemptId: crypto.randomUUID() }; await beginMiniToolStepAttempt(second);
    await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" });
    await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR, attempt: { attemptId: second.attemptId, proof: "rejected" } });
    const state = (await snapshot(f)).step.output.miniToolStep!; expect(state.attempts.map((a) => a.resolution.kind)).toEqual(["identity", "rejected"]);
    await pg`UPDATE tasks SET status='failed' WHERE id=${f.taskId}`; expect((await completeMiniToolConsumptionSet(f.taskId)).consumptionSetComplete).toBe(true);
  });
  it("does not infer that all attempts resolved from the one global canonical ID", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await beginMiniToolStepAttempt({ ...f.input, attemptId: crypto.randomUUID() }); await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" });
    await pg`UPDATE tasks SET status='failed' WHERE id=${f.taskId}`; await expect(completeMiniToolConsumptionSet(f.taskId)).rejects.toThrow(); expect((await snapshot(f)).step.output.miniToolStep!.attempts[1]!.resolution.kind).toBe("unresolved");
  });
  it("does not admit a fresh POST after the original deadline or computation terminal", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR }); const before = await snapshot(f);
    expect((await beginMiniToolStepAttempt({ ...f.input, attemptId: crypto.randomUUID() })).shouldSubmit).toBe(false); expect(await snapshot(f)).toEqual(before);
    // The service compares the deadline with the database clock, so a deadline a full minute past stays past despite drift between
    // the host and the database container.
    const expired = await seed(); expect((await beginMiniToolStepAttempt({ ...expired.input, deadlineAt: Date.now() - 60_000 })).shouldSubmit).toBe(false); expect((await snapshot(expired)).step.output.miniToolStep?.attempts ?? []).toEqual([]);
  });
  it("does not reopen a complete or billed parent to accept an unaccounted receipt", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await pg`UPDATE tasks SET status='failed',billed_at=now(),billed_credits=1,result=result || ${pg.json({ settlement: { version: 4, state: "settled", consumptionSetComplete: true, pendingConsumptionKeys: [], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null } })} WHERE id=${f.taskId}`;
    const before = await snapshot(f); await expect(recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "late-unaccounted" })).rejects.toThrow(); const after = await snapshot(f);
    expect(after.task).toEqual(before.task); expect(after.step.prediction_id).toBeNull(); expect(after.step.output.miniToolConsumption).toBeUndefined(); expect(after.usage).toEqual([]);
  });
  it("serializes two first receipts and rereads current canonical facts under the task lock", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await gated(f, () => recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }), () => recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }));
    const after = await snapshot(f); expect(after.step.prediction_id).toBe("prediction-original"); expect(after.task.result.settlement!.version).toBe(1); expect(after.task.result.settlement!.pendingConsumptionKeys).toHaveLength(1); expect(after.usage).toEqual([]);
  });
});

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
  it("requires a matched persisted expense identity before saving an operation result", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const before = await snapshot(f); await expect(done(f)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
    await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }); await done(f); expect((await snapshot(f)).step.status).toBe("done");
  });
  it("replays the same result without replacing the first canonical result or incrementing costs", async () => {
    const f = await seed(); await identify(f); await done(f); const first = await snapshot(f); await done(f); expect(await snapshot(f)).toEqual(first);
    await expect(done(f, { ...RESULT, frames: [{ ordinal: 0, counts: "5" }] })).rejects.toThrow(); const after = await snapshot(f); expect(after.step.output.miniToolStep!.result).toEqual(first.step.output.miniToolStep!.result); expect(after.step.output.miniToolConsumption).toEqual(first.step.output.miniToolConsumption);
  });
  it("retains a late parsed result but keeps the first failure and failed step state", async () => {
    const f = await seed(); await identify(f); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR }); await done(f); const after = await snapshot(f);
    expect(after.step.status).toBe("failed"); expect(after.step.output.miniToolStep!.error).toEqual(ERROR); expect(after.step.output.miniToolStep!.result!.result).toEqual(RESULT);
    const before = await snapshot(f); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: { code: "replaced" } }); expect(await snapshot(f)).toEqual(before);
  });
  it.each([false, true])("keeps the full container plan and failed completed subset with missingCPU=%s", async (missingCpu) => {
    const { f, plan, identity, parser } = await container(); const before = await snapshot(f);
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: missingCpu ? null : { wallMs: 1234, cpuUsec: 900 }, outputs: [{ outputIndex: 8, storageKey: "issued/frame-8.png", sha256: "a".repeat(64), sizeBytes: 8, contentType: "image/png", width: 2, height: 3, durationSeconds: null, cover: null, upright: null }] };
    await recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report, error: ERROR }, parser); const after = await snapshot(f);
    expect(after.step.status).toBe("failed"); expect(after.step.prediction_id).toBeNull(); expect(after.step.output.miniToolPlanJob).toEqual(plan); expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.step.output.miniToolStep!.result!.result).toEqual(report); expect(after.step.output.miniToolStep!.error).toEqual(ERROR); expect(after.usage).toEqual([]); preserved(before, after);
  });
  it.each([false, true])("merges typed result and actual usage in both observed lock orders, resultFirst=%s", async (resultFirst) => {
    const f = await seed(); await identify(f); const at = await snapshot(f); const identity = at.step.output.miniToolConsumption!.identity;
    await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolConsumption}',(output->'miniToolConsumption') || ${pg.json({ state: "known", costUsd: 0.2, costSource: "generation_lookup", raw: { deduction: 0.2 }, credits: null })}) WHERE id=${f.stepId}`;
    const before = await snapshot(f); const record = (): Promise<unknown> => recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity });
    if (resultFirst) await gated(f, () => done(f), record); else await gated(f, record, () => done(f));
    const after = await snapshot(f); expect(after.step.status).toBe("done"); expect(after.step.output.miniToolStep!.result!.result).toEqual(RESULT); expect(after.step.output.miniToolConsumption).toMatchObject({ state: "recorded", costUsd: 0.2, raw: { deduction: 0.2 } }); expect(after.usage).toHaveLength(1); preserved(before, after);
  });
  it("keeps same-ID/result persistence idempotent for arbitrary repeated pickup counts", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (repeats) => {
      const f = await seed(); await identify(f); await done(f); const first = await snapshot(f);
      for (let i = 0; i < repeats; i += 1) { await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" }); await done(f); }
      expect(await snapshot(f)).toEqual(first);
    }), { numRuns: 8 });
  });
});

/** Invoke one real mutation with a valid receipt or result, leaving scope as the tested variable.
 * @throws {Error} When the actual persistence entry rejects the supplied scope.
 */
function validMutation(kind: "attempt" | "identity" | "result" | "failure", fixture: Fixture): Promise<unknown> {
  switch (kind) {
    case "attempt": return beginMiniToolStepAttempt({ ...fixture.input, attemptId: crypto.randomUUID() });
    case "identity": return recordMiniToolStepIdentity({ taskId: fixture.taskId, stepId: fixture.stepId, attemptId: fixture.input.attemptId, predictionId: "prediction-original" });
    case "result": return done(fixture);
    case "failure": return failMiniToolStep({ taskId: fixture.taskId, stepId: fixture.stepId, error: ERROR });
  }
}

describe("planned step contract branches isolated from earlier terminal shortcuts", () => {
  it.each(["same-attempt", "separate-attempt"] as const)("persists a conflicting %s receipt candidate without replacing canonical expense facts", async (mode) => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input);
    const candidateAttemptId = mode === "same-attempt" ? f.input.attemptId : crypto.randomUUID();
    if (mode === "separate-attempt") await beginMiniToolStepAttempt({ ...f.input, attemptId: candidateAttemptId });
    await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" });
    const identity = (await snapshot(f)).step.output.miniToolConsumption!.identity;
    await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolConsumption}',(output->'miniToolConsumption') || ${pg.json({ state: "known", costUsd: 0.2, costSource: "generation_lookup", raw: { deduction: 0.2 }, credits: null })}) WHERE id=${f.stepId}`;
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity });
    const before = await snapshot(f);
    expect(before.step.output.miniToolConsumption!.state).toBe("recorded"); expect(before.usage).toHaveLength(1);
    const input = { taskId: f.taskId, stepId: f.stepId, attemptId: candidateAttemptId, predictionId: "prediction-candidate" };
    const received = await recordMiniToolStepIdentity(input); const after = await snapshot(f);
    expect(received.conflict).toBe(true); expect(received.consumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.step.status).toBe(before.step.status); expect(after.step.prediction_id).toBe("prediction-original");
    expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.step.output.miniToolStep!.attempts).toEqual(before.step.output.miniToolStep!.attempts);
    expect(after.step.output.miniToolStep!.conflicts).toEqual([{ kind: "identity", attemptId: candidateAttemptId, canonicalId: "prediction-original", candidateId: "prediction-candidate" }]);
    expect(after.task).toEqual(before.task); expect(after.usage).toEqual(before.usage); preserved(before, after);
    expect((await recordMiniToolStepIdentity(input)).conflict).toBe(true); expect(await snapshot(f)).toEqual(after);
    await pg`UPDATE tasks SET status='failed' WHERE id=${f.taskId}`;
    const terminal = await snapshot(f); await expect(completeMiniToolConsumptionSet(f.taskId)).rejects.toThrow(); expect(await snapshot(f)).toEqual(terminal);
  });

  it("persists a distinct valid result conflict while keeping the first result and expense", async () => {
    const f = await seed(); await identify(f); await done(f); const before = await snapshot(f);
    const candidate = { schemaVersion: 1, kind: "tracking_observation", frames: [{ ordinal: 0, counts: "5" }] };
    expect(PARSER.parse(candidate)).toEqual(candidate);
    await expect(done(f, candidate)).rejects.toThrow(); const after = await snapshot(f);
    expect(after.step.status).toBe("done"); expect(after.step.prediction_id).toBe("prediction-original");
    expect(after.step.output.miniToolStep!.result).toEqual(before.step.output.miniToolStep!.result);
    expect(after.step.output.miniToolStep!.conflicts).toEqual([{ kind: "result", result: candidate }]);
    expect(after.step.output.miniToolConsumption).toEqual(before.step.output.miniToolConsumption);
    expect(after.task).toEqual(before.task); expect(after.usage).toEqual(before.usage); preserved(before, after);
    await expect(done(f, candidate)).rejects.toThrow(); expect(await snapshot(f)).toEqual(after);
  });

  it("keeps the first failure on a different repeated error before any typed result exists", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: ERROR });
    const before = await snapshot(f); expect(before.step.status).toBe("failed"); expect(before.step.output.miniToolStep!.result).toBeNull();
    expect(before.step.output.miniToolStep!.error).toEqual(ERROR);
    await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: { code: "later_failure", detail: "A different diagnostic" } });
    expect(await snapshot(f)).toEqual(before);
  });

  it("stores one explicit not-sent proof without fabricating a provider identity or zero cost", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); const before = await snapshot(f);
    const failure = { taskId: f.taskId, stepId: f.stepId, error: { code: "request_not_sent" }, attempt: { attemptId: f.input.attemptId, proof: "not_sent" as const } };
    await failMiniToolStep(failure); const after = await snapshot(f);
    expect(after.step.status).toBe("failed"); expect(after.step.prediction_id).toBeNull(); expect(after.step.output.miniToolConsumption).toBeUndefined(); expect(after.usage).toEqual([]);
    expect(after.step.output.miniToolStep!.attempts).toEqual([{ ...before.step.output.miniToolStep!.attempts[0], resolution: { kind: "not_sent", error: failure.error } }]);
    expect(after.step.output.miniToolStep!.error).toEqual(failure.error); expect(after.task).toEqual(before.task); preserved(before, after);
    await failMiniToolStep(failure); expect(await snapshot(f)).toEqual(after);
  });

  it("rejects a contradictory resolution after a particular attempt was recorded as not sent", async () => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input);
    await failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: { code: "request_not_sent" }, attempt: { attemptId: f.input.attemptId, proof: "not_sent" } });
    const before = await snapshot(f); expect(before.step.output.miniToolStep!.attempts[0]!.resolution.kind).toBe("not_sent");
    await expect(failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: { code: "contradictory_rejection" }, attempt: { attemptId: f.input.attemptId, proof: "rejected" } })).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it("keeps an accepted identity when a later failure tries to classify that attempt as not sent", async () => {
    const f = await seed(); await identify(f); const before = await snapshot(f);
    expect(before.step.output.miniToolStep!.attempts[0]!.resolution).toEqual({ kind: "identity", predictionId: "prediction-original" });
    await expect(failMiniToolStep({ taskId: f.taskId, stepId: f.stepId, error: { code: "contradictory_not_sent" }, attempt: { attemptId: f.input.attemptId, proof: "not_sent" } })).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["completed", "failed"] as const)("fences a new intent when only the parent is %s and the step stays pending", async (status) => {
    const f = await seed(); await beginMiniToolStepAttempt(f.input); await pg`UPDATE tasks SET status=${status} WHERE id=${f.taskId}`;
    const before = await snapshot(f); expect(before.step.status).toBe("pending"); expect(before.step.prediction_id).toBeNull();
    expect(before.step.output.miniToolStep!.deadlineAt).toBeGreaterThan(Date.now()); expect(before.task.result.settlement!.consumptionSetComplete).toBe(false);
    const result = await beginMiniToolStepAttempt({ ...f.input, attemptId: crypto.randomUUID() });
    expect(result.shouldSubmit).toBe(false); expect(result.attempt).toBeNull(); expect(await snapshot(f)).toEqual(before);
  });

  it.each(["attempt", "identity", "result", "failure"] as const)("refuses the %s mutation for an existing non-mini-tool parent", async (kind) => {
    const f = await seed(); await identify(f); await pg`UPDATE tasks SET source='canvas' WHERE id=${f.taskId}`;
    const before = await snapshot(f); await expect(validMutation(kind, f)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
    const [parent] = await pg`SELECT source FROM tasks WHERE id=${f.taskId}`; expect(parent?.source).toBe("canvas");
  });

  it.each(["attempt", "identity", "result", "failure"] as const)("refuses the %s mutation for a missing parent without touching another task's step", async (kind) => {
    const f = await seed(); await identify(f); const before = await snapshot(f); const missing = crypto.randomUUID();
    const [parent] = await pg`SELECT count(*)::int AS count FROM tasks WHERE id=${missing}`; expect(parent?.count).toBe(0);
    const request = { ...f, taskId: missing, input: { ...f.input, taskId: missing } };
    await expect(validMutation(kind, request)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
    const [remaining] = await pg`SELECT count(*)::int AS count FROM tasks WHERE id=${missing}`; expect(remaining?.count).toBe(0);
  });

  it("refuses a parsed failed container report without its required failure diagnostic", async () => {
    const { f, identity, parser } = await container(); const before = await snapshot(f);
    const report = { schemaVersion: 2, state: "failed", reason: "tool_failed", usage: { wallMs: 1234, cpuUsec: 900 }, outputs: [] };
    expect(parser.parse(report)).toEqual(report);
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: f.stepId, identity, outcome: "failed", result: report }, parser)).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["known", "recorded"] as const)("preserves the closed call set and active lookup claim on a same-ID %s replay", async (state) => {
    const f = await seed(); await identify(f); await done(f); const identity = (await snapshot(f)).step.output.miniToolConsumption!.identity;
    await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolConsumption}',(output->'miniToolConsumption') || ${pg.json({ state: "known", costUsd: 0.2, costSource: "generation_lookup", raw: { deduction: 0.2 }, credits: null })}) WHERE id=${f.stepId}`;
    if (state === "recorded") await recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity });
    const open = await snapshot(f); const claim = crypto.randomUUID();
    await pg`UPDATE tasks SET status='completed',result=jsonb_set(result,'{settlement}',(result->'settlement') || ${pg.json({ state: "checking", consumptionSetComplete: true, leaseToken: claim, leaseUntil: "2099-01-01T00:00:00.000000Z" })}) WHERE id=${f.taskId}`;
    const before = await snapshot(f); expect(before.step.status).toBe("done"); expect(before.step.output.miniToolConsumption!.state).toBe(state);
    expect(before.task.result.settlement).toMatchObject({ state: "checking", consumptionSetComplete: true, leaseToken: claim }); expect(before.usage).toEqual(open.usage);
    const replay = await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: f.stepId, attemptId: f.input.attemptId, predictionId: "prediction-original" });
    expect(replay.conflict).toBe(false); expect(replay.consumption).toEqual(before.step.output.miniToolConsumption); expect(await snapshot(f)).toEqual(before);
  });
});
