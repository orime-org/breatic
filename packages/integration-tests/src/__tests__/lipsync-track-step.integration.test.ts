// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lip-sync `track` step body (inner#1306 test plan §97; execution design §9.1, §9.3, §9.4; multi-person lip-sync DD
 * §7.1, §7.2 row 2; frames-split §7.17 paragraph after the recipe table).
 *
 * Real PostgreSQL task, step, attempt and identity boundaries; WaveSpeed `runPrediction` and the ingest `/jobs` boundary
 * (faked at `fetch`, every job done at once) are the controlled external IO, as in remove-background-execution. The step
 * runs through the runner's seam `runLipSyncStep(execution, { kind, personId }, userId, deadlineAt)`
 * (`lipsync-step-run.ts`, §97 D18-2): the shared `prepare` and `prepare:fwd` steps first, then each person's `track:fwd`
 * (execution design §10.2: the anchor at frame 12 of [0, 50) tracks the forward clip [12, 50) from its frame 0).
 *
 * What the design fixes and this file asserts: each referenced person gets its own `generate` step to the tracking model
 * (`tracking.model`, catalog `sam3-video-rle`, provider `wavespeed-ai/sam3-video-rle`), on the prepared video of the used
 * source range (the prepared object is the one the preparation job wrote), with that person's anchor-frame face box as its
 * one box prompt; its submit intent (`beginMiniToolStepAttempt`) is stored before the provider is called; a pickup of a
 * submitted track asks only for its stored prediction; a provider refusal on submit is `failed` for track (only `gen`
 * can be `model_rejected`) and a retryable status is `timeout` (§9.4 category table, `lipsyncStepCategory`).
 *
 * §97 D21-3: the frozen run carries the split-like `container` (policy plus `startSeconds`, `encode`, `chunkRetries`),
 * `layout` `{ preparation, persons, composite }` and `stageJobs`. §97 D21-4: the body is exactly `video`, the text prompt
 * `person` (the endpoint's request schema requires one), one box prompt in prepared-video pixels at the anchor's
 * `frame_index` with `object_id` 1, and `apply_mask` false. §97 D21-5: a failed step
 * names its step.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import { lipsyncPersonStepKeys, lipsyncSharedStepKeys, miniToolStepStateSchema, presentationPinService, taskRepo, upstreamStepRepo } from "@breatic/domain";
import { plannedStageJobs, trackingClips } from "@breatic/shared/mini-tools";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import { HttpStatusError } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { runLipSyncStep } from "@worker/handlers/mini-tool/lipsync-step-run.js";
import { seedStudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { fakeIngestJobs, INGEST_ENV, type IngestJobsFake } from "./ingest-jobs-fake.js";

const { runPrediction } = vi.hoisted(() => ({ runPrediction: vi.fn<typeof wavespeedModule.runPrediction>() }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction }));

const TRACKER_ENDPOINT = "wavespeed-ai/sam3-video-rle";
const PREDICTION = "fixture-track-prediction";
const SOURCE_URL = "https://assets.example.test/video/source.mp4";
// The cfr96 full ledger (320x180, 96 frames at 25 fps, keyframes 0 and 48) that ingest-jobs-fake serves at the receipt URL.
const RECEIPT = {
  schemaVersion: 2, sourceFingerprint: "a".repeat(64), toolInputId: "b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400",
  planSha256: "e7107a03209bc1b3ea4be74b6a6f0e7dd04f0c62431b78560be411c4cda7beb9", producerVersion: 2, attempt: { jobId: "video-presentation:removal-source", deadlineAt: 1900000000000 },
  url: "https://assets.example.test/video/source.mp4.video-source-ledger.b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400.json", etag: "full-etag", size: 1658,
  sha256: "96a73510df6e3319e51e138c0ca8694f96de0881b453074eddd6906f210204ae", contentType: "application/json",
  table: { url: "https://assets.example.test/video/source.mp4.video-presentation-table.b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400.json", sha256: "74c5313481331d9e42c9a8f9b69bff0bed3d0539e36b90020bb1eb5c1a86af74", size: 353, contentType: "application/json", frameCount: 96 },
};
// Two people; the boxes land on whole pixels of the 320x180 display, so no rounding rule is assumed.
const PERSONS = [
  { personId: "person-1", detectionNumber: 1, anchor: { frameIndex: 12, pts: 0.48 }, anchorFaceBox: { x: 0.25, y: 0.2, width: 0.2, height: 0.3 } },
  { personId: "person-3", detectionNumber: 3, anchor: { frameIndex: 12, pts: 0.48 }, anchorFaceBox: { x: 0.625, y: 0.4, width: 0.125, height: 0.2 } },
];
const PIXEL_BOXES = { "person-1": { x_min: 80, y_min: 36, x_max: 144, y_max: 90 }, "person-3": { x_min: 200, y_min: 72, x_max: 240, y_max: 108 } };
const LAYOUT = { preparation: [{ start: 0, end: 50 }], persons: 2, composite: [{ start: 0, end: 50 }], tracking: { forward: [{ start: 12, end: 50 }], reverse: [{ start: 0, end: 13 }] } };
const CLIPS = trackingClips({ start: 0, end: 50 }, 12);

let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;
let jobs: IngestJobsFake;

/** Inject dummy external credentials only. @throws {Error} On invalid fixture configuration. */
function configure(): void {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "fixture-never-sent", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
}

beforeAll(async () => {
  configure(); loadLocales(); pg = createPgClient(inject("DATABASE_URL"), { name: "lipsync-track", max: 6 });
  const storage = await getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => { vi.resetAllMocks(); configure(); jobs = fakeIngestJobs(); });
afterAll(async () => { await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

interface Fixture { execution: Record<string, unknown> & { taskId: string; persons: typeof PERSONS }; userId: string; deadlineAt: number }

/**
 * A running lip-sync parent with its frozen run and its execution pin as admission writes it: two people, a 2 s cut_off timeline whose used range [0, 2) is frames
 * [0, 50) of the cfr96 source.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure.
 */
async function seed(): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "lipsync-track");
  const taskId = randomUUID(); const nodeId = randomUUID(); const spaceId = randomUUID();
  const execution = {
    schemaVersion: 1, tool: "video.lip-sync", taskId, projectId: target.projectId, spaceId, targetNodeIds: [nodeId],
    binding: { assetId: randomUUID(), contentHash: "a".repeat(64), canonicalURL: SOURCE_URL, kind: "video", mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
    sourceKey: "video/source.mp4", draft: {}, analysisRefs: [], outputs: [{ outputIndex: 0, nodeId, recipe: { kind: "lip-sync" } }],
    model: "sync-lipsync-3", credits: 40, requestFingerprint: "c".repeat(64), planFingerprint: "d".repeat(64),
    presentationRef: { source: { toolInputId: RECEIPT.toolInputId, planSha256: RECEIPT.planSha256 } }, ledgerReceipts: { source: RECEIPT }, versionIds: { source: "e".repeat(64) },
    generator: { backend: "wavespeed-crop", modelId: "sync-lipsync-3", schemaFingerprint: "1".repeat(64), providerSyncMode: "cut_off" },
    timeline: { duration: 2, videoDuration: 3.84, syncMode: "cut_off" }, usedRange: { start: 0, end: 2 },
    dialogues: [
      { dialogueId: "row-1", personId: "person-1", audioInputId: randomUUID(), startTime: 0, duration: 2 },
      { dialogueId: "row-2", personId: "person-3", audioInputId: randomUUID(), startTime: 0.5, duration: 1.5 },
    ],
    // DD §7.1 persons row (§97 D21-6): each person's step keys are frozen with it.
    persons: PERSONS.map((person) => ({ ...person, stepKeys: lipsyncPersonStepKeys("d".repeat(64), person, CLIPS) })), tracking: { model: "sam3-video-rle" }, cropSize: 512, faceFeather: 0.1,
    container: { containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
      prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
      limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, startSeconds: 3, encode: { crf: 18, preset: "medium" }, chunkRetries: 2,
      rawDiskBytes: 10_000_000_000 },
    layout: LAYOUT, stageJobs: plannedStageJobs(LAYOUT),
    // Frozen like admission freezes them (DD §7.1 steps row; §97 D25-5).
    sharedStepKeys: lipsyncSharedStepKeys("d".repeat(64), LAYOUT.composite.length, CLIPS),
  };
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${taskId},${target.userId},${target.projectId},${spaceId},'video','append','mini_tool','running',${execution.model},${pg.json({ miniToolExecution: execution })},${pg.json({})})`;
  // The execution pin admission writes; the shared clips are appended to it (execution design §10.2).
  await presentationPinService.acquire({ holderKind: "execution", holderId: taskId, toolInputId: RECEIPT.toolInputId, objectKeys: presentationPinService.ledgerObjectKeys(execution.sourceKey, RECEIPT.toolInputId) });
  const task = await taskRepo.getMiniToolExecutionTask(taskId);
  if (task === null) throw new Error("Fixture parent disappeared");
  return { execution, userId: target.userId, deadlineAt: await taskDeadline(task.id, task.createdAt) };
}

/**
 * Run a shared step until it is done.
 * @param f - The fixture.
 * @param kind - The step.
 * @returns The storage key the last job submitted wrote.
 * @throws {Error} When the step does not finish in four pickups.
 */
async function sharedDone(f: Fixture, kind: "prepare" | "prepare:fwd"): Promise<string> {
  for (let pickup = 0; pickup < 4; pickup += 1) {
    const outcome = await runLipSyncStep(f.execution, { kind, personId: null }, f.userId, f.deadlineAt)
      .catch((error: unknown) => { if (error instanceof StillRunning) return { state: "running" as const }; throw error; });
    if (outcome.state === "done") {
      const last = jobs.submitted.at(-1) as { outputs: { storageKey: string }[] } | undefined;
      if (last === undefined) throw new Error(`${kind} submitted no job`);
      return last.outputs[0]!.storageKey;
    }
    expect(outcome.state).toBe("running");
  }
  throw new Error(`${kind} never finished`);
}

/**
 * Run the shared preparations the forward track needs.
 * @param f - The fixture.
 * @returns The storage key of the forward clip.
 * @throws {Error} When a preparation does not finish.
 */
async function prepared(f: Fixture): Promise<string> {
  await sharedDone(f, "prepare");
  return sharedDone(f, "prepare:fwd");
}

/**
 * The generate steps of the tracking model, in position order.
 * @param f - The fixture.
 * @returns Them.
 */
async function trackSteps(f: Fixture): Promise<Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>> {
  return (await upstreamStepRepo.listSteps(f.execution.taskId)).filter((step) => step.kind === "generate" && step.endpoint === TRACKER_ENDPOINT);
}

describe("the lip-sync track step (§97; execution design §9.1, §9.3; DD §7.2 row 2)", () => {
  it("TK01 submits one SAM3 prediction on the forward clip with the person's anchor box on its frame 0, after storing its submit intent", async () => {
    const f = await seed(); const key = await prepared(f);
    let observed = false;
    runPrediction.mockImplementation(async (_connection, model, body, resume) => {
      expect(model).toBe(TRACKER_ENDPOINT);
      expect(body.video).toBe(publicUrl(key));
      const prompts = body.box_prompts as Record<string, unknown>[];
      expect(prompts).toHaveLength(1);
      // §97 D21-4: one person per request, so object_id 1; the RLE is used, not the preview, so apply_mask false; the box picks the person, so the text prompt only names the class and there is no point prompt.
      expect(prompts[0]).toEqual({ frame_index: 0, object_id: 1, ...PIXEL_BOXES["person-1"] });
      expect(body).toEqual({ video: publicUrl(key), prompt: "person", box_prompts: prompts, apply_mask: false });
      // beginMiniToolStepAttempt came first: one unresolved attempt holding exactly this body.
      const [step] = await trackSteps(f);
      const state = miniToolStepStateSchema.parse(step!.output.miniToolStep);
      expect(state.attempts).toHaveLength(1);
      expect(state.attempts[0]!.resolution).toEqual({ kind: "unresolved" });
      expect(state.requestBody).toEqual(body);
      expect(resume.storedTaskId).toBeNull();
      await resume.persistTaskId(PREDICTION);
      observed = true;
      throw new StillRunning(Date.now() + 1000);
    });
    expect(await runLipSyncStep(f.execution, { kind: "track:fwd", personId: "person-1" }, f.userId, f.deadlineAt)).toEqual({ state: "running" });
    expect(observed).toBe(true);
    const steps = await trackSteps(f);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "submitted", predictionId: PREDICTION });
  });

  it("TK02 gives each referenced person its own tracking step and prompt", async () => {
    const f = await seed(); await prepared(f);
    runPrediction.mockImplementation(async (_connection, _model, _body, resume) => { await resume.persistTaskId(randomUUID()); throw new StillRunning(Date.now() + 1000); });
    for (const person of PERSONS) await runLipSyncStep(f.execution, { kind: "track:fwd", personId: person.personId }, f.userId, f.deadlineAt);
    expect(runPrediction).toHaveBeenCalledTimes(2);
    const prompts = runPrediction.mock.calls.map((call) => (call[2].box_prompts as Record<string, unknown>[]));
    expect(prompts.map((list) => list.length)).toEqual([1, 1]);
    expect(prompts[0]![0]).toMatchObject(PIXEL_BOXES["person-1"]);
    expect(prompts[1]![0]).toMatchObject(PIXEL_BOXES["person-3"]);
    const steps = await trackSteps(f);
    expect(new Set(steps.map((step) => step.id)).size).toBe(2);
  });

  it("TK03 a later pickup of a submitted track asks only for its stored prediction and opens no second attempt", async () => {
    const f = await seed(); await prepared(f);
    runPrediction.mockImplementationOnce(async (_connection, _model, _body, resume) => { await resume.persistTaskId(PREDICTION); throw new StillRunning(Date.now() + 1000); });
    await runLipSyncStep(f.execution, { kind: "track:fwd", personId: "person-1" }, f.userId, f.deadlineAt);
    runPrediction.mockImplementationOnce(async (_connection, _model, _body, resume) => {
      expect(resume.storedTaskId).toBe(PREDICTION);
      throw new StillRunning(Date.now() + 1000);
    });
    expect(await runLipSyncStep(f.execution, { kind: "track:fwd", personId: "person-1" }, f.userId, f.deadlineAt)).toEqual({ state: "running" });
    expect(runPrediction).toHaveBeenCalledTimes(2);
    const [step] = await trackSteps(f);
    expect(miniToolStepStateSchema.parse(step!.output.miniToolStep).attempts).toHaveLength(1);
  });

  it.each([
    ["a refused submit (400) is failed, never model_rejected, for tracking", 400, "failed"],
    ["a retryable status (503) is timeout", 503, "timeout"],
  ] as const)("TK04 %s", async (_name, status, category) => {
    const f = await seed(); await prepared(f);
    runPrediction.mockRejectedValue(new HttpStatusError("wavespeed", status, "fixture refusal"));
    expect(await runLipSyncStep(f.execution, { kind: "track:fwd", personId: "person-1" }, f.userId, f.deadlineAt)).toEqual({ state: "failed", step: "track", category });
  });
});
