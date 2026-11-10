// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The worker's Timeline execution job (inner#1711 design §3.5, §5.2, §5.3, §6; acceptance V2, V4).
 *
 * `runTimelineExecution(job, token)` is the `timeline` queue's processor. A pickup takes the row with a new attempt
 * and fence (claim from queued, retry from running) and never moves the original deadline; it reads the container
 * job before submitting it, submits the fixed `timeline:<executionId>` job, and throws `StillRunning` while the job
 * runs. Only a terminal report settles: each completed call is a usage row under `timeline:<executionId>:<seq>`, an
 * interrupted or cut-off call a zero row marked missing, an upstream error no row, the container one row; then the
 * `billed_at` gate decides whether this writer charges actual use: it writes a `timeline_execution` charge request in
 * the same commit as `billed_at` and then settles it (inner#1617), and a settle that fails leaves the request pending
 * for the sweep without failing the execution. Acceptance held no credits, so no path releases a hold and no charge
 * names one; the run has no spend ceiling of its own. The job lock is re-checked before the source insert, the usage,
 * the charge and the terminal transition.
 *
 * Real database and Yjs database; the ingest Worker is a stand-in on `INGEST_BASE_URL`, the Manifest is served from
 * a stubbed storage read, and only the credit engine's settle and hold release are doubles, so they can be counted.
 * The charge request itself is the real row.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

const settle = vi.hoisted(() => vi.fn(async (_requestId: string): Promise<Record<string, unknown> | null> => null));
const release = vi.hoisted(() => vi.fn(async (_referenceId: string): Promise<void> => {}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    creditLotService: { ...actual.creditLotService, settleCharge: settle },
    creditHoldService: { ...actual.creditHoldService, releaseHold: release },
  };
});

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_count: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import type * as DomainModule from "@breatic/domain";
import fc from "fast-check";
import { createPgClient, env, getStreamRedis, getTimelineConfig, initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import { toChargeCredits } from "@breatic/domain";
import { spaceTasksChangedChannel } from "@breatic/shared";
import { WEB_ANIMATION_CONTAINER_CLASS, webAnimationJobRequestSchema } from "@breatic/shared/space-content";
import { runTimelineExecution } from "@worker/handlers/timeline/web-animation-execution.js";
import {
  CALLS,
  asJob,
  captureErrorLogs,
  expectedSource,
  featureDisabled,
  holdsFor,
  installFakeIngest,
  isWaiting,
  jobFor,
  json,
  manifest,
  read,
  report,
  seedExecution,
  serveManifest,
  sourceRows,
  usageRows,
  type ExecutionFixture,
  type FakeIngest,
  type StartState,
} from "@integration-tests/__tests__/timeline-worker-fixtures.js";

let sql: ReturnType<typeof createPgClient>;
let errorLogs: () => Record<string, unknown>[];
const owned: string[] = [];

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  errorLogs = captureErrorLogs("timeline-worker");
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-worker-driver", max: 6, prepare: false });
});

beforeEach(() => {
  settle.mockReset();
  settle.mockImplementation(async () => ({ billed: true, charged: "0", shortfall: "0", studioId: null, lotIds: [] }));
  release.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (owned.length > 0) await sql`UPDATE timeline_executions SET deleted_at = now() WHERE id = ANY(${owned}::uuid[])`;
  owned.length = 0;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const TOKEN = "lock-token";

/**
 * Seed an execution this suite cleans up.
 * @param state - Where it starts.
 * @returns The fixture.
 */
async function seed(state: StartState): Promise<ExecutionFixture> {
  const fx = await seedExecution(sql, state);
  owned.push(fx.execution.id);
  return fx;
}

/**
 * Run one pickup; waiting for a later pickup is a normal outcome.
 * @param fx - The execution.
 * @param lockAnswers - What the job lock answers, call by call.
 * @param token - The attempt's lock token.
 * @returns The job the pickup ran with.
 * @throws {unknown} Anything other than "wait for the next pickup".
 */
async function pickUp(fx: ExecutionFixture, lockAnswers: number[] = [1], token = TOKEN): Promise<ReturnType<typeof jobFor>> {
  const job = jobFor(fx.execution.id, lockAnswers);
  try {
    await runTimelineExecution(asJob(job), token);
  } catch (err) {
    if (!isWaiting(err)) throw err;
  }
  return job;
}

/** One charge request, as the credit engine stores it. */
interface ChargeRequest {
  id: string;
  kind: string;
  projectId: string | null;
  actorUserId: string;
  amount: number;
  referenceId: string;
  releaseHold: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
}

/**
 * The charge requests written for one execution.
 * @param executionId - The execution.
 * @returns Its requests.
 */
async function chargesFor(executionId: string): Promise<ChargeRequest[]> {
  const rows = await sql<{
    id: string; kind: string; project_id: string | null; actor_user_id: string; amount: string; reference_id: string;
    release_hold: string | null; status: string; attempts: number; last_error: string | null;
  }[]>`
    SELECT id, kind, project_id, actor_user_id, amount::text AS amount, reference_id, release_hold, status, attempts, last_error
    FROM credit_charge_requests WHERE reference_id = ${executionId}
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    actorUserId: row.actor_user_id,
    amount: Number(row.amount),
    referenceId: row.reference_id,
    releaseHold: row.release_hold,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
  }));
}

/**
 * How many times the credit engine was asked to settle one execution's requests.
 * @param executionId - The execution.
 * @returns The settle calls naming one of its requests.
 */
async function settlesFor(executionId: string): Promise<number> {
  const ids = new Set((await chargesFor(executionId)).map((request) => request.id));
  return settle.mock.calls.filter(([requestId]) => ids.has(requestId)).length;
}

/**
 * The usage rows a report with one completed call and one interrupted call leaves, before the container row.
 * @param executionId - The execution.
 * @returns The two model rows.
 */
function modelRows(executionId: string): Record<string, unknown>[] {
  const model = getTimelineConfig().web_animation.model;
  return [
    {
      source: "model", provider: "openrouter", model, feature: "timeline_web_animation",
      cost_identity: `timeline:${executionId}:1`, cost_source: "provider", cost_usd: 0.0125, credits: 1.25 * env.CREDIT_MULTIPLIER,
      input_tokens: 1_200, cached_input_tokens: 200, output_tokens: 300, reasoning_tokens: 100,
    },
    {
      source: "model", provider: "openrouter", model, feature: "timeline_web_animation",
      cost_identity: `timeline:${executionId}:3`, cost_source: "missing", cost_usd: 0, credits: 0,
      input_tokens: 900, cached_input_tokens: 0, output_tokens: 40, reasoning_tokens: 0,
    },
  ];
}

/**
 * How many Space task-list signals a spied publish sent for the execution's Project.
 * @param publish - The spy on the stream Redis client's publish.
 * @param fx - The execution.
 * @returns The count.
 */
function signalsFor(publish: { mock: { calls: unknown[][] } }, fx: ExecutionFixture): number {
  const channel = spaceTasksChangedChannel(env.REDIS_KEY_PREFIX, fx.projectId);
  return publish.mock.calls.filter(([published]) => published === channel).length;
}

/**
 * What the credit engine must be asked to charge: the recorded rows' credits, settled once.
 * @param fx - The execution.
 * @returns The charge input.
 */
async function expectedCharge(fx: ExecutionFixture): Promise<Record<string, unknown>> {
  const rows = await usageRows(sql, fx.execution.id);
  return expect.objectContaining({
    kind: "timeline_execution",
    projectId: fx.projectId,
    actorUserId: fx.userId,
    amount: toChargeCredits(rows.reduce((sum, row) => sum + row.credits, 0)),
    referenceId: fx.execution.id,
  });
}

/**
 * Assert no hold exists for the execution, none was released and no charge names one: acceptance held nothing.
 * @param fx - The execution.
 */
async function expectNothingHeld(fx: ExecutionFixture): Promise<void> {
  expect((await chargesFor(fx.execution.id)).filter((request) => request.releaseHold !== null)).toEqual([]);
  expect(release.mock.calls.filter(([referenceId]) => referenceId === fx.execution.id)).toEqual([]);
  expect(await holdsFor(sql, fx.execution.id)).toEqual([]);
}

describe("picking up a queued execution", () => {
  it("claims it with a new fence, records the job before submitting it, and submits the fixed job under the original deadline", async () => {
    const fx = await seed("queued");
    const ingest = installFakeIngest(fx);
    await pickUp(fx);
    const row = await read(fx.execution.id);
    expect(row).toMatchObject({ status: "running", attempt: 1, deadlineAt: fx.execution.deadlineAt });
    expect(row.fence).toMatch(/^[0-9a-f-]{36}$/);
    const jobId = `timeline:${fx.execution.id}`;
    const deadlineAt = Date.parse(fx.execution.deadlineAt);
    // The step holds the job once, as its request.
    expect(row.steps).toEqual([
      { kind: "container_job", request: expect.objectContaining({ jobId, containerClass: WEB_ANIMATION_CONTAINER_CLASS, deadlineAt }) },
    ]);
    expect(ingest.calls.map((call) => call.route)).toEqual(["read", "submit"]);
    const config = getTimelineConfig().web_animation;
    // The raw body, not a parse of it: the request carries no spend ceiling, and a parse would strip one.
    expect(ingest.calls[1]!.body).not.toHaveProperty("costCeilingUsd");
    const submitted = webAnimationJobRequestSchema.parse(ingest.calls[1]!.body);
    expect(submitted).toEqual({
      containerClass: WEB_ANIMATION_CONTAINER_CLASS,
      jobId,
      deadlineAt,
      prompt: "A red square slides in",
      viewport: submitted.viewport,
      fps: { num: 24, den: 1 },
      durationFrames: 96,
      packageKey: fx.packageKey,
      manifestKey: fx.manifestKey,
      fontSetVersion: config.font_set_version,
      maxPackageBytes: config.max_package_bytes,
      maxTokens: config.max_tokens,
      callTimeoutMs: config.call_timeout_ms,
      model: config.model,
    });
    expect(submitted.viewport.width * 9).toBe(submitted.viewport.height * 16);
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    expect(await usageRows(sql, fx.execution.id)).toEqual([]);
  });

  it("waits for the next pickup by throwing StillRunning while the job runs", async () => {
    const fx = await seed("queued");
    installFakeIngest(fx);
    const job = jobFor(fx.execution.id);
    await expect(runTimelineExecution(asJob(job), TOKEN)).rejects.toSatisfy(isWaiting);
  });
});

describe("picking up a running execution again", () => {
  it("retries with a new attempt and fence, keeps the deadline, and reads the job instead of submitting it again", async () => {
    const fx = await seed("queued");
    const ingest = installFakeIngest(fx);
    await pickUp(fx);
    const first = await read(fx.execution.id);
    ingest.read = () => json(report(fx, "running", { calls: [CALLS.completed] }));
    await pickUp(fx);
    const second = await read(fx.execution.id);
    expect(second).toMatchObject({ status: "running", attempt: 2, deadlineAt: fx.execution.deadlineAt });
    expect(second.fence).not.toBeNull();
    expect(second.fence).not.toBe(first.fence);
    expect(ingest.calls.map((call) => [call.route, call.jobId])).toEqual([
      ["read", `timeline:${fx.execution.id}`],
      ["submit", `timeline:${fx.execution.id}`],
      ["read", `timeline:${fx.execution.id}`],
    ]);
  });

  it("signals the Space nothing when a pickup finds the job in the phase it already noted", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "running", { phase: "writing" }));
    await pickUp(fx);
    expect((await read(fx.execution.id)).phase).toBe("writing");
    const publish = vi.spyOn(getStreamRedis(), "publish");
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "running", attempt: 3, phase: "writing" });
    expect(signalsFor(publish, fx)).toBe(0);
  });

  it("signals the Space once when a pickup finds the job in a new phase", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "running", { phase: "writing" }));
    await pickUp(fx);
    const publish = vi.spyOn(getStreamRedis(), "publish");
    ingest.read = () => json(report(fx, "running", { phase: "validating" }));
    await pickUp(fx);
    expect((await read(fx.execution.id)).phase).toBe("validating");
    expect(signalsFor(publish, fx)).toBe(1);
  });

  it("does not settle a report that has not ended", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "running", { calls: [CALLS.completed, CALLS.interrupted] }));
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "running", attempt: 2, billedAt: null });
    expect(ingest.calls.map((call) => call.route)).toEqual(["read"]);
    expect(await usageRows(sql, fx.execution.id)).toEqual([]);
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    await expectNothingHeld(fx);
  });

  it("still submits the same job from a step stored with the job's fields beside its request", async () => {
    const fx = await seed("queued");
    const ingest = installFakeIngest(fx);
    await pickUp(fx);
    const [stored] = (await read(fx.execution.id)).steps as [{ request: Record<string, unknown> }];
    const { jobId, containerClass, deadlineAt } = stored.request;
    const older = [{ kind: "container_job", jobId, containerClass, deadlineAt, request: stored.request }];
    // The step was read back from jsonb, so every value in it is JSON.
    await sql`UPDATE timeline_executions SET steps = ${sql.json(older)} WHERE id = ${fx.execution.id}`;
    await pickUp(fx);
    const submits = ingest.calls.filter((call) => call.route === "submit");
    expect(ingest.calls.map((call) => [call.route, call.jobId])).toEqual([
      ["read", `timeline:${fx.execution.id}`],
      ["submit", `timeline:${fx.execution.id}`],
      ["read", `timeline:${fx.execution.id}`],
      ["submit", `timeline:${fx.execution.id}`],
    ]);
    expect(submits[1]!.body).toEqual(submits[0]!.body);
  });

  it("submits again on the next pickup after the Worker answered 503", async () => {
    const fx = await seed("queued");
    const ingest = installFakeIngest(fx);
    ingest.submit = () => new Response("container unavailable", { status: 503 });
    await pickUp(fx);
    expect((await read(fx.execution.id)).status).toBe("running");
    await expectNothingHeld(fx);
    ingest.submit = () => json(report(fx, "running", { calls: [], outputs: [] }));
    await pickUp(fx);
    const submits = ingest.calls.filter((call) => call.route === "submit");
    expect(submits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(submits.map((call) => JSON.stringify(call.body))).size).toBe(1);
    expect((await read(fx.execution.id)).status).toBe("running");
  });
});

describe("picking up a cancelling execution", () => {
  it("cancels the container job and acknowledges the cancelled report, settling what it spent", async () => {
    const fx = await seed("cancelling");
    const ingest = installFakeIngest(fx);
    const cancelled = report(fx, "cancelled", { calls: [CALLS.completed, CALLS.interrupted] });
    ingest.cancel = () => json(cancelled);
    ingest.read = () => json(cancelled);
    await pickUp(fx);
    const row = await read(fx.execution.id);
    expect(row).toMatchObject({ status: "cancelled", fence: null });
    expect(ingest.calls.filter((call) => call.route === "cancel").map((call) => call.jobId)).toEqual([`timeline:${fx.execution.id}`]);
    expect(ingest.calls.filter((call) => call.route === "submit")).toEqual([]);
    expect((await usageRows(sql, fx.execution.id)).filter((r) => r.source === "model")).toEqual(modelRows(fx.execution.id));
    expect(await chargesFor(fx.execution.id)).toEqual([await expectedCharge(fx)]);
    await expectNothingHeld(fx);
  });

  it("acknowledges a cancel that reached the Worker before any submit, charging and releasing nothing", async () => {
    const fx = await seed("cancelling");
    const ingest = installFakeIngest(fx);
    const before = report(fx, "cancelled_before_submit", { calls: [], container: null });
    ingest.cancel = () => json(before);
    ingest.read = () => json(before);
    await pickUp(fx);
    expect((await read(fx.execution.id)).status).toBe("cancelled");
    expect(ingest.calls.filter((call) => call.route === "submit")).toEqual([]);
    expect(await usageRows(sql, fx.execution.id)).toEqual([]);
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    await expectNothingHeld(fx);
  });
});

describe("settling a terminal report", () => {
  it("records the source, one row per settled call and the container, charges once and succeeds", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    await pickUp(fx);
    const sources = await sourceRows(sql, fx.execution.id);
    expect(sources).toEqual([expectedSource(fx, getTimelineConfig().web_animation.font_set_version)]);
    const row = await read(fx.execution.id);
    expect(row).toMatchObject({ status: "succeeded", resultSourceVersionId: sources[0]!.id, fence: null });
    const rows = await usageRows(sql, fx.execution.id);
    expect(rows.filter((r) => r.source === "model")).toEqual(modelRows(fx.execution.id));
    expect(rows.filter((r) => r.source === "container")).toEqual([
      expect.objectContaining({ feature: "timeline_web_animation", cost_identity: null, provider: "cloudflare" }),
    ]);
    expect(rows.some((r) => r.cost_identity === `timeline:${fx.execution.id}:2`)).toBe(false);
    const charged = await expectedCharge(fx);
    expect(await chargesFor(fx.execution.id)).toEqual([charged]);
    expect(await settlesFor(fx.execution.id)).toBe(1);
    const amount = toChargeCredits(rows.reduce((sum, r) => sum + r.credits, 0));
    expect(Number(row.billedCredits)).toBe(amount);
    expect(row.billedAt).not.toBeNull();
    await expectNothingHeld(fx);
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({ executionId: fx.execution.id, seq: 3, generationId: "gen-3", outcome: "interrupted" }),
    );
  });

  it("settles a failed report, recording a call the crash cut off at zero, and fails with the report's reason", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "failed", { calls: [CALLS.completed, CALLS.cutOff] }));
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "failed", failureReason: "dsh_failed", resultSourceVersionId: null });
    const models = (await usageRows(sql, fx.execution.id)).filter((r) => r.source === "model");
    expect(models.map((r) => [r.cost_identity, r.cost_source, r.cost_usd])).toEqual([
      [`timeline:${fx.execution.id}:1`, "provider", 0.0125],
      [`timeline:${fx.execution.id}:4`, "missing", 0],
    ]);
    expect(await sourceRows(sql, fx.execution.id)).toEqual([]);
    expect(await chargesFor(fx.execution.id)).toEqual([await expectedCharge(fx)]);
    await expectNothingHeld(fx);
  });

  it("fails a done report whose Manifest does not match the accepted input, still settling what it spent", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest({ fps: { num: 30, den: 1 } }));
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "failed", failureReason: "fps_mismatch", resultSourceVersionId: null });
    expect(await sourceRows(sql, fx.execution.id)).toEqual([]);
    expect((await usageRows(sql, fx.execution.id)).filter((r) => r.source === "model")).toEqual(modelRows(fx.execution.id));
    expect(await chargesFor(fx.execution.id)).toEqual([await expectedCharge(fx)]);
    await expectNothingHeld(fx);
  });

  // inner#1617: the request committed with billed_at, so a settle that fails loses nothing. The execution still
  // ends as it should, and the request waits pending, its failure counted on the row by the credit engine, for
  // the sweep. The settle here is the real one, refused by the ledger, so the engine's own count is what is read.
  it("keeps the request pending, records and logs the failure, and still succeeds when the settle fails", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    const { creditLotService: real } = await vi.importActual<typeof DomainModule>("@breatic/domain");
    settle.mockImplementation((requestId) => real.settleCharge(requestId) as Promise<Record<string, unknown> | null>);
    // DDL takes no bind parameters; the id is a uuid this suite minted.
    await sql.unsafe(`ALTER TABLE credit_ledger ADD CONSTRAINT timeline_ledger_block CHECK (reference_id IS DISTINCT FROM '${fx.execution.id}') NOT VALID`);
    try {
      await pickUp(fx);
    } finally {
      await sql.unsafe("ALTER TABLE credit_ledger DROP CONSTRAINT timeline_ledger_block");
    }
    const row = await read(fx.execution.id);
    expect(row.status).toBe("succeeded");
    expect(row.billedAt).not.toBeNull();
    const requests = await chargesFor(fx.execution.id);
    expect(requests).toEqual([await expectedCharge(fx)]);
    expect(requests[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(requests[0]!.lastError).toContain("timeline_ledger_block");
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({
        msg: "credit_charge_settle_failed",
        executionId: fx.execution.id,
        userId: fx.userId,
        projectId: fx.projectId,
        requestId: requests[0]!.id,
      }),
    );
  });

  it("writes no charge request when the billed_at update rolls back with it", async () => {
    // The request and billed_at share one commit: a request refused by the database takes billed_at with it, so a
    // later pickup still finds the execution unbilled and charges it then.
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    // DDL takes no bind parameters; the id is a uuid this suite minted.
    await sql.unsafe(`ALTER TABLE credit_charge_requests ADD CONSTRAINT timeline_worker_block CHECK (reference_id <> '${fx.execution.id}') NOT VALID`);
    try {
      await pickUp(fx).catch(() => undefined);
    } finally {
      await sql`ALTER TABLE credit_charge_requests DROP CONSTRAINT timeline_worker_block`;
    }
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    expect((await read(fx.execution.id)).billedAt).toBeNull();
    await pickUp(fx, [1], "after-rollback");
    expect(await chargesFor(fx.execution.id)).toEqual([await expectedCharge(fx)]);
    expect((await read(fx.execution.id)).status).toBe("succeeded");
  });

  it("charges and releases nothing when another writer already set billed_at", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    expect(await timelineExecutionRepo.markBilled(fx.execution.id, "1.25")).toBe(true);
    await pickUp(fx);
    expect((await read(fx.execution.id)).status).toBe("succeeded");
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    await expectNothingHeld(fx);
  });

  it("finishes a run whose earlier writer charged and lost its lock, without a second charge or row", async () => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    await pickUp(fx, [1, 1, 1, 0], "first-token").catch(() => undefined);
    expect(await chargesFor(fx.execution.id)).toHaveLength(1);
    const rowsAfterFirst = await usageRows(sql, fx.execution.id);
    await pickUp(fx, [1], "second-token");
    expect((await read(fx.execution.id)).status).toBe("succeeded");
    expect(await chargesFor(fx.execution.id)).toHaveLength(1);
    expect(await settlesFor(fx.execution.id)).toBe(1);
    expect(await usageRows(sql, fx.execution.id)).toEqual(rowsAfterFirst);
    expect(await sourceRows(sql, fx.execution.id)).toHaveLength(1);
    await expectNothingHeld(fx);
  });

  it("charges at most once however up to four writers of one terminal report interleave", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.nat({ max: 20 }), { minLength: 4, maxLength: 4 }),
        async (writers, delays) => {
          const fx = await seed("running");
          const ingest = installFakeIngest(fx);
          ingest.read = () => json(report(fx, "done"));
          await serveManifest(fx, manifest());
          await Promise.all(
            Array.from({ length: writers }, async (_, index) => {
              await new Promise((resolve) => setTimeout(resolve, delays[index]));
              await pickUp(fx, [1], `writer-${index}`);
            }),
          );
          const row = await read(fx.execution.id);
          const sources = await sourceRows(sql, fx.execution.id);
          expect(await chargesFor(fx.execution.id)).toHaveLength(1);
          expect(await settlesFor(fx.execution.id)).toBe(1);
          expect(row).toMatchObject({ status: "succeeded", resultSourceVersionId: sources[0]!.id });
          expect(sources).toHaveLength(1);
          const rows = await usageRows(sql, fx.execution.id);
          expect(rows.filter((r) => r.source === "model")).toEqual(modelRows(fx.execution.id));
          expect(rows.filter((r) => r.source === "container")).toHaveLength(1);
        },
      ),
      { numRuns: 8 },
    );
  });
});

describe("the job lock", () => {
  it.each([
    { answers: [0], sources: 0, usage: 0, charges: 0 },
    { answers: [1, 0], sources: 1, usage: 0, charges: 0 },
    { answers: [1, 1, 0], sources: 1, usage: 3, charges: 0 },
    { answers: [1, 1, 1, 0], sources: 1, usage: 3, charges: 1 },
  ])("is checked before the source, the usage, the charge and the terminal transition (lock answers $answers)", async ({ answers, sources, usage, charges }) => {
    const fx = await seed("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    const job = jobFor(fx.execution.id, answers);
    await runTimelineExecution(asJob(job), TOKEN).catch(() => undefined);
    expect(await sourceRows(sql, fx.execution.id)).toHaveLength(sources);
    expect(await usageRows(sql, fx.execution.id)).toHaveLength(usage);
    expect(await chargesFor(fx.execution.id)).toHaveLength(charges);
    expect((await read(fx.execution.id)).status).toBe("running");
    expect(job.extendLock).toHaveBeenCalledTimes(answers.length);
    expect(job.extendLock.mock.calls.every(([token]) => token === TOKEN)).toBe(true);
  });
});

describe("an ingest Worker without web-animation execution", () => {
  /**
   * Assert the row ended as not available here, with nothing charged or released.
   * @param fx - The execution.
   * @param status - The terminal status the matrix gives this row.
   */
  async function expectFeatureDisabled(fx: ExecutionFixture, status: "failed" | "cancelled"): Promise<void> {
    const row = await read(fx.execution.id);
    expect(row.status).toBe(status);
    if (status === "failed") expect(row.failureReason).toBe("feature_disabled");
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    expect(await usageRows(sql, fx.execution.id)).toEqual([]);
    await expectNothingHeld(fx);
  }

  it("fails the execution as feature_disabled when the submit answers 501", async () => {
    const fx = await seed("queued");
    const ingest = installFakeIngest(fx);
    ingest.submit = () => featureDisabled();
    await pickUp(fx);
    await expectFeatureDisabled(fx, "failed");
  });

  it("fails the execution as feature_disabled when the read answers 501", async () => {
    const fx = await seed("queued");
    const ingest: FakeIngest = installFakeIngest(fx);
    await pickUp(fx);
    ingest.read = () => featureDisabled();
    await pickUp(fx);
    await expectFeatureDisabled(fx, "failed");
  });

  it("ends a cancelling execution when the cancel answers 501", async () => {
    const fx = await seed("cancelling");
    const ingest = installFakeIngest(fx);
    ingest.cancel = () => featureDisabled();
    ingest.read = () => featureDisabled();
    await pickUp(fx);
    // A failure on a cancelling row ends it cancelled (design §7.1 matrix, `timelineExecutionRepo.transition`).
    await expectFeatureDisabled(fx, "cancelled");
  });
});

describe("the original deadline", () => {
  it("settles a terminal report found two polls past the deadline and ends the execution expired", async () => {
    const fx = await seed("running");
    await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 hour' WHERE id = ${fx.execution.id}`;
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "done"));
    await serveManifest(fx, manifest());
    await pickUp(fx);
    expect((await read(fx.execution.id)).status).toBe("expired");
    expect((await usageRows(sql, fx.execution.id)).filter((r) => r.source === "model")).toEqual(modelRows(fx.execution.id));
    expect(await chargesFor(fx.execution.id)).toEqual([await expectedCharge(fx)]);
    await expectNothingHeld(fx);
  });

  it("cancels a job still running two polls past the deadline and settles nothing yet", async () => {
    const fx = await seed("running");
    await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 hour' WHERE id = ${fx.execution.id}`;
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "running"));
    ingest.cancel = () => json(report(fx, "stopping"));
    await pickUp(fx);
    expect(ingest.calls.filter((call) => call.route === "cancel").map((call) => call.jobId)).toEqual([`timeline:${fx.execution.id}`]);
    expect((await read(fx.execution.id)).status).toBe("running");
    expect(await usageRows(sql, fx.execution.id)).toEqual([]);
    expect(await chargesFor(fx.execution.id)).toEqual([]);
  });

  it("leaves a running job alone within two polls of the deadline", async () => {
    const fx = await seed("running");
    await sql`UPDATE timeline_executions SET deadline_at = now() - interval '10 milliseconds' WHERE id = ${fx.execution.id}`;
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(report(fx, "running"));
    await pickUp(fx);
    expect(ingest.calls.map((call) => call.route)).toEqual(["read"]);
    expect(await read(fx.execution.id)).toMatchObject({ status: "running", attempt: 2 });
  });

  it("expires a queued execution past its deadline without submitting, releasing nothing", async () => {
    const fx = await seed("queued");
    await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 hour' WHERE id = ${fx.execution.id}`;
    const ingest = installFakeIngest(fx);
    await pickUp(fx);
    expect((await read(fx.execution.id)).status).toBe("expired");
    expect(ingest.calls.filter((call) => call.route === "submit")).toEqual([]);
    expect(await chargesFor(fx.execution.id)).toEqual([]);
    await expectNothingHeld(fx);
  });
});
