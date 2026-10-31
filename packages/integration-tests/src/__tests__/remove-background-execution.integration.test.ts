// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Real PostgreSQL task, intent, identity, consumption, result and canonical receipt boundaries.
 * WaveSpeed runPrediction and worker storeFromUrl are controlled external boundaries.
 * Their call counts are adapter calls, not measured HTTP requests or R2 transfers.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import {
  assetRepo, beginMiniToolStepAttempt, miniToolConsumptionRecordSchema, miniToolStepStateSchema,
  recordMiniToolStepIdentity, taskRepo, upstreamStepRepo,
  type AcceptedMiniToolExecution, type StoredAsset,
} from "@breatic/domain";
import { hashMiniToolValue } from "@breatic/shared/mini-tools";
import type { StudioAssetEntity } from "@breatic/shared";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import type * as uploadModule from "@worker/handlers/backend-upload.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { runMiniToolRemoveBackground } from "@worker/handlers/mini-tool/run-remove-background.js";
import { seedStudioFixture, type StudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";

const { runPrediction, storeFromUrl } = vi.hoisted(() => ({
  runPrediction: vi.fn<typeof wavespeedModule.runPrediction>(), storeFromUrl: vi.fn<typeof uploadModule.storeFromUrl>(),
}));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction }));
vi.mock("@worker/handlers/backend-upload.js", async (original) => ({ ...await original<typeof uploadModule>(), storeFromUrl }));

const PREDICTION = "fixture-prediction-original";
const PROVIDER_URL = "https://provider.example.test/result.webm";
const OUTPUT_HASH = "147d7b46f5062b1cc7231edff71bed11071dd088c5b3434432f24e5d41037a07";
const BODY = { video: "https://assets.example.test/video/source.mp4", background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true } as const;
const GOLDEN: Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }> = {
  schemaVersion: 1, tool: "video.remove-bg", taskId: "50000000-0000-4000-8000-000000000001", projectId: "10000000-0000-4000-8000-000000000001", spaceId: "20000000-0000-4000-8000-000000000001",
  targetNodeIds: ["40000000-0000-4000-8000-000000000001"],
  binding: { assetId: "80000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: BODY.video, kind: "video", mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } },
  sourceKey: "video/source.mp4",
  draft: { version: 1, draftId: "60000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000001", source: { nodeId: "30000000-0000-4000-8000-000000000001", canonicalURL: BODY.video, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } }, inputs: [], params: {} },
  analysisRefs: [], outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "remove-bg" } }],
  model: "fixture-bria-fibo-video", provider: { provider: "wavespeed", model_id: "bria/fibo/video-background-remover" }, body: BODY, credits: 30,
  requestFingerprint: "f5ed98e04016b9001c24d0d525eccd576898e5c454dc529cc0715712b1ec135e", planFingerprint: "8bc4ec38c3f353492d0f7feca81963d398171ae1f42e66e146723f82962cedf4",
};
interface Fixture extends StudioFixture { plan: Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>; deadlineAt: number; sourceId: string; assetId: string; coverId: string; canonicalURL: string; coverURL: string }
interface TaskRow { status: string; params: { miniToolExecution: AcceptedMiniToolExecution }; result: Record<string, unknown>; billed_at: string | null; billed_credits: number | null }
let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;

/** Inject only dummy external credentials and preserve the existing library configuration owner.
 * @throws {Error} When the injected fixture configuration is invalid.
 */
function configure(multiplier = 1): void {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: String(multiplier), WAVESPEED_API_KEY: "fixture-never-sent", UPLOAD_BASE_URL: "https://assets.example.test" });
}

beforeAll(async () => {
  configure(); loadLocales(); pg = createPgClient(inject("DATABASE_URL"), { name: "remove-bg-leaf", max: 6 });
  const storage = await getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => { vi.resetAllMocks(); configure(); });
afterAll(async () => { await pg.end(); initCore(process.env); });

/** Hash exactly the approved plan projection, retaining the independent complete golden separately.
 * @throws {TypeError} When a plan is not a finite canonical JSON value.
 */
async function planHash(plan: AcceptedMiniToolExecution): Promise<string> {
  const { requestFingerprint: _request, planFingerprint: _plan, ...projection } = plan;
  return hashMiniToolValue(projection);
}

/** Seed SQL parent and registered rows; these are fixtures, not evidence of a transfer or media decode.
 * @throws {Error} When fixture SQL or the original deadline owner fails.
 */
async function seed(golden = false): Promise<Fixture> {
  expect(await planHash(GOLDEN)).toBe("8bc4ec38c3f353492d0f7feca81963d398171ae1f42e66e146723f82962cedf4");
  const target = await seedStudioFixture(pg, "rb"); const source = await seedStudioFixture(pg, "rs");
  const plan = structuredClone(GOLDEN);
  if (golden) {
    await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${plan.projectId},${target.studioId},${target.userId},${`rb-${randomUUID()}`},'Remove background')`;
  } else {
    plan.taskId = randomUUID(); plan.projectId = target.projectId; plan.spaceId = randomUUID(); plan.binding.assetId = randomUUID();
    plan.draft.draftId = randomUUID(); plan.draft.revision = randomUUID(); plan.draft.source.nodeId = randomUUID();
    plan.targetNodeIds = [randomUUID()]; plan.outputs[0]!.nodeId = plan.targetNodeIds[0]!; plan.planFingerprint = await planHash(plan);
  }
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${plan.binding.assetId},${source.studioId},${plan.binding.contentHash},${plan.sourceKey},${BODY.video},4096,'video/mp4','video','upload',${source.userId},960,540,5.055)`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${plan.taskId},${target.userId},${plan.projectId},${plan.spaceId},'video','append','mini_tool','running',${plan.model},${pg.json({ miniToolExecution: { ...plan } })},${pg.json({ kept: { original: true } })})`;
  const assetId = randomUUID(); const coverId = randomUUID(); const canonicalURL = publicUrl(`video/winner/${assetId}.webm`); const coverURL = publicUrl(`image/cover/${coverId}.png`);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height)
    VALUES (${coverId},${target.studioId},${"c".repeat(64)},${`image/cover/${coverId}.png`},${coverURL},128,'image/png','image','cover',${target.userId},96,54)`;
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,generation_task_id,width,height,duration_seconds,cover_asset_id)
    VALUES (${assetId},${target.studioId},${OUTPUT_HASH},${`video/winner/${assetId}.webm`},${canonicalURL},1588436,'video/webm','video','ai',${target.userId},${plan.taskId},960,540,5.013,${coverId})`;
  const task = await taskRepo.getMiniToolExecutionTask(plan.taskId);
  if (task === null) throw new Error("Fixture parent disappeared");
  const deadlineAt = await taskDeadline(task.id, task.createdAt);
  return { ...target, projectId: plan.projectId, plan, deadlineAt, sourceId: plan.binding.assetId, assetId, coverId, canonicalURL, coverURL };
}

/** Read parent facts independently of the worker and provider response.
 * @throws {Error} When the fixture parent disappeared.
 */
async function parent(f: Fixture): Promise<TaskRow> {
  const [row] = await pg<TaskRow[]>`SELECT status,params,result,billed_at::text,billed_credits FROM tasks WHERE id=${f.plan.taskId}`;
  if (!row) throw new Error("Fixture parent disappeared"); return row;
}

/** Require the sole original generate descriptor before reading its persisted JSON.
 * @throws {Error} When the existing step contract is violated.
 */
async function step(f: Fixture): Promise<Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number]> {
  const rows = await upstreamStepRepo.listSteps(f.plan.taskId); expect(rows).toHaveLength(1);
  const row = rows[0]!; expect(row).toMatchObject({ position: 0, kind: "generate", endpoint: GOLDEN.provider.model_id, itemIndex: 0 }); return row;
}

/** Reproduce a completed external answer while letting the real callback save its identity.
 * @throws {Error} When the actual identity transaction fails.
 */
function completeProvider(): void {
  runPrediction.mockImplementation(async (_connection, _model, _body, resume) => {
    if (resume.storedTaskId === null) await resume.persistTaskId(PREDICTION);
    return { taskId: resume.storedTaskId ?? PREDICTION, outputs: [PROVIDER_URL] };
  });
}

/** Return the controlled backend receipt that points at a real registered SQL winner.
 * @throws {never} Never.
 */
function backend(f: Fixture, presentationQueueFailed = false): void {
  const stored: StoredAsset = { assetId: f.assetId, fileUrl: f.canonicalURL, kind: "video", coverUrl: f.coverURL, width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436, ...(presentationQueueFailed ? { presentationQueueFailed: true } : {}) };
  storeFromUrl.mockResolvedValue(stored);
}

/** Require actual winner rows and the original immutable parent without invoking any finalizer.
 * @throws {Error} When persisted rows no longer satisfy their fixture contract.
 */
async function winner(f: Fixture, result: { asset: StudioAssetEntity; cover: StudioAssetEntity | null }): Promise<void> {
  expect(result.asset).toMatchObject({ id: f.assetId, studioId: f.studioId, contentHash: OUTPUT_HASH, fileUrl: f.canonicalURL, sizeBytes: 1588436,
    mimeType: "video/webm", kind: "video", width: 960, height: 540, durationSeconds: 5.013 });
  expect(result.cover).toMatchObject({ id: f.coverId, fileUrl: f.coverURL, kind: "image", mimeType: "image/png" });
  expect(result.asset).toEqual(await assetRepo.findById(f.assetId)); expect(result.cover).toEqual(await assetRepo.findCoverOf(f.assetId));
  const task = await parent(f); expect(task).toMatchObject({ status: "running", params: { miniToolExecution: f.plan }, result: { kept: { original: true } }, billed_at: null, billed_credits: null });
  const [source] = await pg<{ content_hash: string; width: number; height: number; duration_seconds: number }[]>`SELECT content_hash,width,height,duration_seconds::float8 AS duration_seconds FROM studio_assets WHERE id=${f.sourceId}`;
  expect(source).toEqual({ content_hash: "a".repeat(64), width: 960, height: 540, duration_seconds: 5.055 });
}

/** Prepare the original real intent and optional identity without mocking SQL owners.
 * @throws {Error} When the actual persistence owners fail.
 */
async function identify(f: Fixture, prediction = true): Promise<{ stepId: string; attemptId: string }> {
  const [owned] = await upstreamStepRepo.ensureSteps(f.plan.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]);
  if (!owned) throw new Error("Fixture step disappeared"); const attemptId = randomUUID();
  expect((await beginMiniToolStepAttempt({ taskId: f.plan.taskId, stepId: owned.id, attemptId, requestBody: { ...f.plan.body }, deadlineAt: f.deadlineAt, chargeTo: "user" })).shouldSubmit).toBe(true);
  if (prediction) await recordMiniToolStepIdentity({ taskId: f.plan.taskId, stepId: owned.id, attemptId, predictionId: PREDICTION });
  return { stepId: owned.id, attemptId };
}

describe("SQL frozen removal execution and provider persistence", () => {
  it("S04-S05 saves intent before the adapter and identity plus pending consumption before its controlled question", async () => {
    const f = await seed(true); const waiting = new StillRunning(Date.now() + 1000); let observedQuestion = false;
    runPrediction.mockImplementation(async (_connection, model, body, resume) => {
      expect(model).toBe("bria/fibo/video-background-remover"); expect(body).toEqual(BODY);
      expect(resume).toMatchObject({ storedTaskId: null, deadlineAt: f.deadlineAt, retryStarting: false });
      const before = await step(f); const intent = miniToolStepStateSchema.parse(before.output.miniToolStep);
      expect(intent).toMatchObject({ requestBody: BODY, deadlineAt: f.deadlineAt, chargeTo: "user", creditMultiplier: 1 });
      expect(intent.attempts).toHaveLength(1); expect(intent.attempts[0]!.resolution).toEqual({ kind: "unresolved" });
      expect(before.output.miniToolConsumption).toBeUndefined();
      await resume.persistTaskId(PREDICTION);
      const after = await step(f); expect(after).toMatchObject({ id: before.id, status: "submitted", predictionId: PREDICTION });
      const consumption = miniToolConsumptionRecordSchema.parse(after.output.miniToolConsumption);
      expect(consumption).toMatchObject({ identity: { kind: "provider", provider: "wavespeed", predictionId: PREDICTION }, state: "pending", chargeTo: "user", creditMultiplier: 1, costUsd: null, credits: null });
      expect((await parent(f)).result.settlement).toMatchObject({ consumptionSetComplete: false, pendingConsumptionKeys: [consumption.consumptionKey] });
      observedQuestion = true; throw waiting;
    });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBe(waiting);
    expect(observedQuestion).toBe(true); expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("S06 queries only the stored prediction with the original body, policy and step deadline", async () => {
    const f = await seed(); const owned = await identify(f); const waiting = new StillRunning(Date.now() + 1000); const before = await step(f); configure(2);
    runPrediction.mockImplementation(async (_connection, model, body, resume) => {
      expect(model).toBe(GOLDEN.provider.model_id); expect(body).toEqual(BODY); expect(resume.storedTaskId).toBe(PREDICTION); expect(resume.deadlineAt).toBe(f.deadlineAt); throw waiting;
    });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt + 90000, true)).rejects.toBe(waiting);
    expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).not.toHaveBeenCalled();
    const after = await step(f); expect(after).toEqual(before); expect(after.id).toBe(owned.stepId);
    expect(miniToolConsumptionRecordSchema.parse(after.output.miniToolConsumption)).toMatchObject({ state: "pending", creditMultiplier: 1, costUsd: null, credits: null });
  });
  it("S09 does not reach the external adapter when the actual intent write fails", async () => {
    const f = await seed(); const [owned] = await upstreamStepRepo.ensureSteps(f.plan.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]);
    if (!owned) throw new Error("Fixture step missing"); const trigger = `rb_${randomUUID().replaceAll("-", "")}`;
    await pg.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${owned.id}'::uuid THEN RAISE EXCEPTION 'remove bg intent blocked'; END IF; RETURN NEW; END $$`);
    await pg.unsafe(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON task_upstream_steps FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try { await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toMatchObject({ cause: { message: expect.stringContaining("remove bg intent blocked") } }); }
    finally { await pg.unsafe(`DROP TRIGGER ${trigger} ON task_upstream_steps`); await pg.unsafe(`DROP FUNCTION ${trigger}()`); }
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
    const after = await step(f); expect(after.status).toBe("pending"); expect(after.output.miniToolStep).toBeUndefined(); expect(after.output.miniToolConsumption).toBeUndefined();
  });
  it("S09 does not bypass the same persisted unresolved intent's replay gate", async () => {
    const f = await seed(); const held = await identify(f, false);
    expect((await beginMiniToolStepAttempt({ taskId: f.plan.taskId, stepId: held.stepId, attemptId: held.attemptId, requestBody: { ...f.plan.body }, deadlineAt: f.deadlineAt, chargeTo: "user" })).shouldSubmit).toBe(false);
    const before = await step(f);
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toThrow();
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect(await step(f)).toEqual(before);
  });
  it("S13 persists the typed result before transfer and keeps the pending original expense", async () => {
    const f = await seed(); completeProvider(); backend(f); let observedResult = false;
    storeFromUrl.mockImplementationOnce(async () => {
      const owned = await step(f); expect(owned).toMatchObject({ status: "done", predictionId: PREDICTION });
      expect(miniToolStepStateSchema.parse(owned.output.miniToolStep).result).toMatchObject({ outcome: "done", error: null });
      expect(miniToolConsumptionRecordSchema.parse(owned.output.miniToolConsumption)).toMatchObject({ state: "pending", costUsd: null, credits: null });
      observedResult = true; return { assetId: f.assetId, fileUrl: f.canonicalURL, kind: "video", coverUrl: f.coverURL, width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436 };
    });
    await winner(f, await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)); expect(observedResult).toBe(true);
  });
  it("S13 reuses a saved result after a controlled transfer failure without another prediction query", async () => {
    const f = await seed(); completeProvider(); const failed = new Error("controlled transfer failure"); storeFromUrl.mockRejectedValueOnce(failed);
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBe(failed);
    expect((await step(f)).status).toBe("done"); runPrediction.mockClear(); backend(f);
    await winner(f, await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, true)); expect(runPrediction).not.toHaveBeenCalled();
  });
  it.each([[], [PROVIDER_URL, PROVIDER_URL], ["not-a-url"], [{ url: PROVIDER_URL }], [42]].map((outputs) => ({ outputs })))("S13 rejects invalid or multiple provider outputs $outputs without losing stored identity", async ({ outputs }) => {
    const f = await seed(); await identify(f);
    runPrediction.mockResolvedValue({ taskId: PREDICTION, outputs });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, true)).rejects.toThrow();
    expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).not.toHaveBeenCalled();
    const owned = await step(f); expect(owned.predictionId).toBe(PREDICTION); expect(owned.status).toBe("submitted");
    expect(miniToolConsumptionRecordSchema.parse(owned.output.miniToolConsumption)).toMatchObject({ state: "pending", costUsd: null, credits: null });
  });
});

describe("canonical registration receipt from actual SQL winner rows", () => {
  it("C01-C02 forwards the original upload context and returns the winner and live cover", async () => {
    const f = await seed(); completeProvider(); backend(f);
    await winner(f, await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false));
    expect(storeFromUrl).toHaveBeenCalledExactlyOnceWith(PROVIDER_URL, { projectId: f.plan.projectId, actingUserId: f.userId, generationTaskId: f.plan.taskId, assetSource: "ai", taskType: "video", ext: ".webm", contentType: "video/webm", deadlineAt: f.deadlineAt, knownAlpha: true });
    const owned = await step(f); expect(owned.output["miniToolAsset:0"]).toBe(f.assetId);
  });
  it("C02 retains a dedup winner's existing SQL attribution rather than fabricating a new row", async () => {
    const f = await seed(); await pg`UPDATE studio_assets SET source='upload',generation_task_id=NULL WHERE id=${f.assetId}`;
    completeProvider(); backend(f); const result = await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false);
    await winner(f, result); expect(result.asset).toMatchObject({ id: f.assetId, source: "upload", generationTaskId: null, contentHash: OUTPUT_HASH });
  });
  it("C03 replays the persisted receipt without another adapter call or transfer", async () => {
    const f = await seed(); completeProvider(); backend(f); const first = await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false); await winner(f, first);
    const before = await step(f); runPrediction.mockClear(); storeFromUrl.mockClear();
    expect(await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt + 90000, true)).toEqual(first);
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect(await step(f)).toEqual(before);
  });
  it("C03 rereads the live SQL receipt and does not return a subsequently deleted winner", async () => {
    const f = await seed(); completeProvider(); backend(f); await winner(f, await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false));
    await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.assetId}`; runPrediction.mockClear(); storeFromUrl.mockClear();
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, true)).rejects.toThrow();
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect((await step(f)).output["miniToolAsset:0"]).toBe(f.assetId);
  });
  it("C05 preserves canonical success when the controlled backend receipt reports a presentation queue failure", async () => {
    const f = await seed(); completeProvider(); backend(f, true);
    await winner(f, await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false));
    expect((await step(f)).output["miniToolAsset:0"]).toBe(f.assetId); expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).toHaveBeenCalledTimes(1);
  });
});

describe("persisted lane and complete plan are checked before paid boundaries", () => {
  it.each(["taskId", "projectId", "spaceId"] as const)("rejects a validly hashed plan with a different parent %s", async (field) => {
    const f = await seed(); const changed = structuredClone(f.plan); changed[field] = randomUUID(); changed.planFingerprint = await planHash(changed);
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...changed } })} WHERE id=${f.plan.taskId}`;
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toThrow();
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("rejects a body changed without updating its original plan hash", async () => {
    const f = await seed(); const changed = structuredClone(f.plan); changed.body.video = "https://provider.example.test/replaced.mp4";
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...changed } })} WHERE id=${f.plan.taskId}`;
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toThrow(); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it.each(["wrong source", "wrong type"])("rejects the SQL %s lane instead of using the frozen namespace as authority", async (label) => {
    const f = await seed();
    if (label === "wrong source") await pg`UPDATE tasks SET source='agent' WHERE id=${f.plan.taskId}`;
    else await pg`UPDATE tasks SET task_type='image' WHERE id=${f.plan.taskId}`;
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toThrow(); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
});
