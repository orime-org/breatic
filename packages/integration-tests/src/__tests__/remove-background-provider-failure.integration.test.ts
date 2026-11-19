// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S12 and the original submitted/failed step table: PostgreSQL owners remain real.
 * Provider and upload adapters are controlled; call counts do not measure HTTP or R2 IO.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import {
  beginMiniToolStepAttempt, failMiniToolStep, miniToolConsumptionRecordSchema,
  miniToolStepStateSchema, recordMiniToolStepIdentity, taskRepo, upstreamStepRepo,
} from "@breatic/domain";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import type * as uploadModule from "@worker/handlers/backend-upload.js";
import { runMiniToolRemoveBackground } from "@worker/handlers/mini-tool/run-remove-background.js";
import * as shared from "@breatic/shared";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { executionSnapshot, seedExecution, type ExecutionFixture } from "../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";

const { runPrediction, storeFromUrl } = vi.hoisted(() => ({
  runPrediction: vi.fn<typeof wavespeedModule.runPrediction>(),
  storeFromUrl: vi.fn<typeof uploadModule.storeFromUrl>(),
}));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction }));
vi.mock("@worker/handlers/backend-upload.js", async (original) => ({ ...await original<typeof uploadModule>(), storeFromUrl }));

const P = "original-failed-prediction";
const WORDS = "Original provider refusal: SELECT and params are input words";
let pg: ReturnType<typeof createPgClient>;
interface Submitted { fixture: ExecutionFixture; deadlineAt: number; stepId: string }

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "unused-provider-failure-fixture", UPLOAD_BASE_URL: "https://assets.example.test",
    INGEST_BASE_URL: "https://ingest.example.test", INGEST_SHARED_SECRET: "fixture-ingest-secret" });
  loadLocales(); pg = createPgClient(inject("DATABASE_URL"), { name: "provider-failure-fixture", max: 4 });
});
beforeEach(() => {
  vi.resetAllMocks();
  // S6e E3b: the removal's model input is prepared on standard-4 before generate; the ingest /jobs boundary answers done at once.
  const submitted: Record<string, unknown>[] = [];
  const done = (request: Record<string, unknown>): Record<string, unknown> => {
    const output = (request.outputs as { outputIndex: number; storageKey: string; contentType: string }[])[0]!;
    return { schemaVersion: 2, state: "done", outputs: [{ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType }], usage: { wallMs: 1000, cpuUsec: 2000000 } };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") { const request = JSON.parse(String(init.body)) as Record<string, unknown>; submitted.push(request); return Response.json(done(request)); }
    const request = submitted.find((candidate) => candidate.jobId === decodeURIComponent(url.pathname.split("/").at(-1)!));
    return request === undefined ? new Response("missing", { status: 404 }) : Response.json(done(request));
  }));
});
afterAll(async () => { await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

/** Save the original submit intent, canonical identity and pending consumption through real owners.
 * @throws {Error} When a legitimate fixture cannot be persisted or read.
 */
async function submitted(): Promise<Submitted> {
  const fixture = await seedExecution(pg, "running");
  const task = await taskRepo.getMiniToolExecutionTask(fixture.taskId);
  if (task === null) throw new Error("Original parent disappeared");
  const deadlineAt = await taskDeadline(task.id, task.createdAt);
  const [step] = await upstreamStepRepo.ensureSteps(task.id, [{ kind: "generate", endpoint: fixture.plan.provider.model_id, itemIndex: 0 }]);
  if (step === undefined) throw new Error("Original provider step disappeared");
  const attemptId = randomUUID();
  expect((await beginMiniToolStepAttempt({ taskId: task.id, stepId: step.id, attemptId, requestBody: { ...fixture.plan.body, video: `https://assets.example.test/${(shared as unknown as { videoPresentationWorkKeyFor: (key: string, id: string) => string }).videoPresentationWorkKeyFor(fixture.plan.sourceKey, `${task.id}:prep:0:a1`)}` }, deadlineAt, chargeTo: "user" })).shouldSubmit).toBe(true);
  expect((await recordMiniToolStepIdentity({ taskId: task.id, stepId: step.id, attemptId, predictionId: P })).conflict).toBe(false);
  const result = { fixture, deadlineAt, stepId: step.id };
  expect(await originalStep(result)).toMatchObject({ id: step.id, status: "submitted", predictionId: P });
  expect(miniToolConsumptionRecordSchema.parse((await originalStep(result)).output.miniToolConsumption)).toMatchObject({
    identity: { kind: "provider", provider: "wavespeed", predictionId: P }, state: "pending", chargeTo: "user", creditMultiplier: 1, costUsd: null, credits: null,
  });
  return result;
}

/** Read the sole original descriptor rather than trusting the controlled provider answer.
 * @throws {Error} When the original descriptor or its ownership changes.
 */
async function originalStep(s: Submitted): Promise<Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number]> {
  const steps = await upstreamStepRepo.listSteps(s.fixture.taskId);
  expect(steps).toHaveLength(1);
  const step = steps[0]!;
  expect(step).toMatchObject({ id: s.stepId, position: 0, kind: "generate", endpoint: s.fixture.plan.provider.model_id, itemIndex: 0 });
  return step;
}

/** Observe that recording a provider failure does not mutate its existing fee or frozen request facts.
 * @throws {Error} When the actual persistence owners cannot be read.
 */
async function preserved(s: Submitted, before: Awaited<ReturnType<typeof originalStep>>, parent: Awaited<ReturnType<typeof executionSnapshot>>): Promise<void> {
  const after = await originalStep(s);
  expect(after.predictionId).toBe(P);
  expect(after.output.miniToolConsumption).toEqual(before.output.miniToolConsumption);
  const oldState = miniToolStepStateSchema.parse(before.output.miniToolStep);
  const newState = miniToolStepStateSchema.parse(after.output.miniToolStep);
  expect({ ...newState, error: oldState.error, result: oldState.result }).toEqual(oldState);
  expect(await executionSnapshot(pg, s.fixture)).toEqual(parent);
  expect(storeFromUrl).not.toHaveBeenCalled();
}

describe("original provider failure step persistence", () => {
  it("S12 marks the actual submitted prediction failed and keeps its original vendor reason and pending expense", async () => {
    const s = await submitted(); const before = await originalStep(s); const parent = await executionSnapshot(pg, s.fixture);
    const original = new UpstreamTaskFailed("wavespeed", WORDS);
    runPrediction.mockImplementation(async (_connection, _model, _body, resume) => {
      expect(resume).toMatchObject({ storedTaskId: P, deadlineAt: s.deadlineAt });
      throw original;
    });
    await expect(runMiniToolRemoveBackground(s.fixture.taskId, s.deadlineAt, false)).rejects.toBe(original);
    const after = await originalStep(s);
    expect(after.status).toBe("failed");
    const state = miniToolStepStateSchema.parse(after.output.miniToolStep);
    // The existing error object owns its field names; the contract preserves the actual vendor words.
    expect(JSON.stringify(state.error)).toContain(original.upstreamError);
    await preserved(s, before, parent);
    expect(runPrediction).toHaveBeenCalledTimes(1);
  });

  it("S12 replays the original failed step without another provider request or replacement of its first error", async () => {
    const s = await submitted();
    await failMiniToolStep({ taskId: s.fixture.taskId, stepId: s.stepId, error: { message: WORDS } });
    const before = await originalStep(s); const parent = await executionSnapshot(pg, s.fixture);
    expect(before.status).toBe("failed");
    const later = new UpstreamTaskFailed("wavespeed", "A later controlled answer must not replace the original failure");
    runPrediction.mockRejectedValue(later);
    const error: unknown = await runMiniToolRemoveBackground(s.fixture.taskId, s.deadlineAt, true).then(() => null, (caught: unknown) => caught);
    expect(runPrediction).not.toHaveBeenCalled();
    expect(storeFromUrl).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(UpstreamTaskFailed);
    expect(error).toMatchObject({ upstreamError: WORDS });
    expect(await originalStep(s)).toEqual(before);
    expect(await executionSnapshot(pg, s.fixture)).toEqual(parent);
  });

  it.each(["ordinary Error", "StillRunning"] as const)("S12 leaves the original submitted state unchanged for %s", async (kind) => {
    const s = await submitted(); const before = await originalStep(s); const parent = await executionSnapshot(pg, s.fixture);
    const original = kind === "ordinary Error" ? new Error("Controlled transient query failure") : new StillRunning(Date.now() + 1000);
    runPrediction.mockRejectedValue(original);
    await expect(runMiniToolRemoveBackground(s.fixture.taskId, s.deadlineAt, true)).rejects.toBe(original);
    expect(await originalStep(s)).toEqual(before);
    expect(await executionSnapshot(pg, s.fixture)).toEqual(parent);
    expect(runPrediction).toHaveBeenCalledTimes(1);
    expect(runPrediction.mock.calls[0]![3]).toMatchObject({ storedTaskId: P, deadlineAt: s.deadlineAt });
    expect(storeFromUrl).not.toHaveBeenCalled();
  });
});
