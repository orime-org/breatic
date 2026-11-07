// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The worker's Timeline sweep and failed-job handler (inner#1711 design §5.2; acceptance V1, V2).
 *
 * `sweepTimelineExecutions(queue)` runs on a schedule over executions that have not ended. An awaiting-landing row
 * past its original deadline expires; nothing was held at acceptance, so nothing is released. A deleted Space gets no
 * handling of its own, as with canvas tasks (deleting a Space is a restorable soft delete): its awaiting-landing row
 * is left alone until that same deadline. A queued row whose dispatch time has come, and every running or cancelling
 * row, must have a live job in the
 * `timeline` queue under its execution id: a missing, failed or completed job is removed and added again, because the
 * default retention would otherwise keep the old job id occupied.
 *
 * `reportTimelineJobFailed(queue, jobId, failedReason)` is the queue's `QueueEvents` 'failed' handler: a job that used
 * up its retries is only logged; the row and its container are left for the sweep and the original deadline to
 * finish.
 *
 * Real database, Yjs database and Redis; the real `timeline` queue. Nothing here may call the ingest Worker. Only the
 * credit engine's hold release is a double, so a release can be seen.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

const release = vi.hoisted(() => vi.fn(async (_referenceId: string): Promise<void> => {}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, creditHoldService: { ...actual.creditHoldService, releaseHold: release } };
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
import type { Job, Queue } from "bullmq";
import { createPgClient, createQueue, createWorker, env, getStreamRedis, initCore, loadLocales, type Redis } from "@breatic/core";
import { sweepTimelineExecutions } from "@worker/handlers/timeline/timeline-sweep.js";
import { reportTimelineJobFailed } from "@worker/handlers/timeline/timeline-failed-job.js";
import {
  captureErrorLogs,
  deleteSpace,
  holdsFor,
  read,
  seedExecution,
  type ExecutionFixture,
  type StartState,
} from "@integration-tests/__tests__/timeline-worker-fixtures.js";

let sql: ReturnType<typeof createPgClient>;
let errorLogs: () => Record<string, unknown>[];
let queue: Queue;
let subscriber: Redis;
const signals: { channel: string; message: Record<string, unknown> }[] = [];
const network = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`the sweep must not call out, but requested ${String(input)}`);
});

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  errorLogs = captureErrorLogs("timeline-sweep");
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-sweep-driver", max: 4, prepare: false });
  queue = createQueue("timeline");
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    signals.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
});

beforeEach(async () => {
  signals.length = 0;
  network.mockClear();
  release.mockReset();
  vi.stubGlobal("fetch", network);
  // The sweep reads every open row; rows other suites left open would crowd this suite's out of a batch.
  await sql`
    UPDATE timeline_executions SET deleted_at = now()
    WHERE deleted_at IS NULL AND status IN ('awaiting_landing', 'queued', 'running', 'cancelling')
  `;
  await queue.obliterate({ force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await subscriber?.quit();
  await queue?.obliterate({ force: true });
  await queue?.close();
  await sql?.end({ timeout: 1 });
});

/**
 * Seed an execution, optionally moving its deadline into the past.
 * @param state - Where it starts.
 * @param options - What a case varies.
 * @param options.late - Whether its deadline has passed.
 * @returns The fixture.
 */
async function seed(state: StartState, options: { late?: boolean } = {}): Promise<ExecutionFixture> {
  const fx = await seedExecution(sql, state);
  if (options.late) await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 minute' WHERE id = ${fx.execution.id}`;
  return fx;
}

/**
 * Leave a finished job in the queue under the execution's id, as BullMQ keeps it for its retention period.
 * @param executionId - The execution.
 * @param outcome - How the job ended.
 * @returns The finished job's timestamp.
 */
async function finishedJob(executionId: string, outcome: "failed" | "completed"): Promise<number> {
  const added = await queue.add("timeline-execution", { executionId }, { jobId: executionId, attempts: 1 });
  const worker = createWorker<{ executionId: string }>("timeline", async (job: Job<{ executionId: string }>) => {
    if (job.id !== executionId) return;
    if (outcome === "failed") throw new Error("handler gave up");
  });
  try {
    const deadline = Date.now() + 10_000;
    while ((await queue.getJob(executionId))?.finishedOn === undefined) {
      if (Date.now() > deadline) throw new Error("fixture job never finished");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await worker.close();
  }
  expect(await (await queue.getJob(executionId))!.getState()).toBe(outcome);
  return added.timestamp;
}

/**
 * The live job an execution has after the sweep.
 * @param executionId - The execution.
 * @returns Its state, data and timestamp.
 */
async function liveJob(executionId: string): Promise<{ state: string; data: unknown; timestamp: number } | null> {
  const job = await queue.getJob(executionId);
  if (job === undefined) return null;
  return { state: await job.getState(), data: job.data, timestamp: job.timestamp };
}

/**
 * The space-tasks signals one Space received, after giving late ones time to arrive.
 * @param fx - The execution.
 * @returns Them.
 */
async function signalsFor(fx: ExecutionFixture): Promise<Record<string, unknown>[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return signals.filter((s) => s.channel.includes(fx.projectId) && s.message.spaceId === fx.spaceId).map((s) => s.message);
}

const WAITING = ["waiting", "delayed", "prioritized"];

/**
 * Assert no hold exists for the execution and none was released: acceptance held nothing.
 * @param fx - The execution.
 */
async function expectNothingHeld(fx: ExecutionFixture): Promise<void> {
  expect(release.mock.calls.filter(([referenceId]) => referenceId === fx.execution.id)).toEqual([]);
  expect(await holdsFor(sql, fx.execution.id)).toEqual([]);
}

describe("sweeping rows that never landed", () => {
  it("expires an awaiting-landing row past its original deadline, releasing nothing, and signals the Space", async () => {
    const fx = await seed("awaiting_landing", { late: true });
    await sweepTimelineExecutions(queue);
    expect(await read(fx.execution.id)).toMatchObject({ status: "expired", fence: null });
    await expectNothingHeld(fx);
    expect(await liveJob(fx.execution.id)).toBeNull();
    expect(await signalsFor(fx)).toEqual([
      { type: "project-space-tasks:changed", projectId: fx.projectId, spaceId: fx.spaceId, ts: expect.any(Number) },
    ]);
  });

  it("leaves an awaiting-landing row whose Space was deleted alone until its original deadline, then expires it", async () => {
    const fx = await seed("awaiting_landing");
    await deleteSpace(fx.projectId, fx.spaceId);
    await sweepTimelineExecutions(queue);
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    expect(await signalsFor(fx)).toEqual([]);
    await sql`UPDATE timeline_executions SET deadline_at = now() - interval '1 minute' WHERE id = ${fx.execution.id}`;
    await sweepTimelineExecutions(queue);
    expect(await read(fx.execution.id)).toMatchObject({ status: "expired", failureReason: null, fence: null });
    await expectNothingHeld(fx);
  });

  it("leaves an awaiting-landing row in its Space and within its deadline alone", async () => {
    const fx = await seed("awaiting_landing");
    const late = await seed("awaiting_landing", { late: true });
    await sweepTimelineExecutions(queue);
    expect((await read(late.execution.id)).status).toBe("expired");
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    await expectNothingHeld(fx);
    expect(await liveJob(fx.execution.id)).toBeNull();
  });

  it("does not expire a row a second time once it has ended", async () => {
    const fx = await seed("awaiting_landing", { late: true });
    await sweepTimelineExecutions(queue);
    const ended = await read(fx.execution.id);
    expect(ended.status).toBe("expired");
    await signalsFor(fx);
    signals.length = 0;
    await sweepTimelineExecutions(queue);
    expect(await read(fx.execution.id)).toEqual(ended);
    expect(await signalsFor(fx)).toEqual([]);
  });
});

describe("sweeping rows that should have a job", () => {
  it("adds the job of a queued row whose dispatch time has come", async () => {
    const fx = await seed("queued");
    await sweepTimelineExecutions(queue);
    const job = await liveJob(fx.execution.id);
    expect(WAITING).toContain(job?.state);
    expect(job?.data).toMatchObject({ executionId: fx.execution.id });
    expect((await read(fx.execution.id)).status).toBe("queued");
  });

  it("leaves a queued row alone until its dispatch time", async () => {
    const fx = await seed("queued");
    await sql`UPDATE timeline_executions SET next_dispatch_at = now() + interval '1 hour' WHERE id = ${fx.execution.id}`;
    const due = await seed("queued");
    await sweepTimelineExecutions(queue);
    expect(WAITING).toContain((await liveJob(due.execution.id))?.state);
    expect(await liveJob(fx.execution.id)).toBeNull();
  });

  it.each(["running", "cancelling"] as const)("adds the missing job of a %s row", async (state) => {
    const fx = await seed(state);
    await sweepTimelineExecutions(queue);
    const job = await liveJob(fx.execution.id);
    expect(WAITING).toContain(job?.state);
    expect(job?.data).toMatchObject({ executionId: fx.execution.id });
    expect(await read(fx.execution.id)).toEqual(fx.execution);
  });

  it.each([
    { state: "running", outcome: "failed" },
    { state: "running", outcome: "completed" },
    { state: "cancelling", outcome: "failed" },
    { state: "cancelling", outcome: "completed" },
  ] as const)("replaces the $outcome job of a $state row that has not ended", async ({ state, outcome }) => {
    const fx = await seed(state);
    const oldTimestamp = await finishedJob(fx.execution.id, outcome);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sweepTimelineExecutions(queue);
    const job = await liveJob(fx.execution.id);
    expect(WAITING).toContain(job?.state);
    expect(job!.timestamp).toBeGreaterThan(oldTimestamp);
    expect(job?.data).toMatchObject({ executionId: fx.execution.id });
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps the job a running row already has waiting", async () => {
    const fx = await seed("running");
    const added = await queue.add("timeline-execution", { executionId: fx.execution.id }, { jobId: fx.execution.id });
    const orphan = await seed("running");
    await sweepTimelineExecutions(queue);
    expect(WAITING).toContain((await liveJob(orphan.execution.id))?.state);
    const job = await liveJob(fx.execution.id);
    expect(job?.timestamp).toBe(added.timestamp);
    expect(WAITING).toContain(job?.state);
  });
});

describe("a timeline job that used up its retries", () => {
  it("is only logged: the row, its fence and its container are left as they were", async () => {
    const fx = await seed("running");
    await finishedJob(fx.execution.id, "failed");
    await reportTimelineJobFailed(queue, fx.execution.id, "handler gave up");
    expect(errorLogs().filter((row) => row.executionId === fx.execution.id)).toEqual([
      expect.objectContaining({ executionId: fx.execution.id, attempt: fx.execution.attempt }),
    ]);
    expect(await read(fx.execution.id)).toEqual(fx.execution);
    await expectNothingHeld(fx);
    expect(network).not.toHaveBeenCalled();
  });

  it("is added again by the next sweep, with the original deadline", async () => {
    const fx = await seed("running");
    await finishedJob(fx.execution.id, "failed");
    await reportTimelineJobFailed(queue, fx.execution.id, "handler gave up");
    await sweepTimelineExecutions(queue);
    expect(WAITING).toContain((await liveJob(fx.execution.id))?.state);
    expect((await read(fx.execution.id)).deadlineAt).toBe(fx.execution.deadlineAt);
  });
});
