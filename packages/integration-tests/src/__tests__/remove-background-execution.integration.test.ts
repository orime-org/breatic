// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real PostgreSQL task, intent, identity, consumption, result and canonical receipt boundaries.
 * WaveSpeed runPrediction and worker storeFromUrl are controlled external boundaries.
 * Their call counts are adapter calls, not measured HTTP requests or R2 transfers.
 *
 * S6e E3b (inner#1306 test plan §90; design §5.3 model-input row, §5.4 作业身份, §7.1.1, §7.11): the frozen body's
 * video is the prepared reference `<taskId>:prep:0`; before `generate`, the runner registers and runs the
 * `prepare_model_input` standard-4 job(s) through the ingest `/jobs` boundary (faked at `fetch`, done on submit unless a
 * case says otherwise), then submits `generate` with the prepared object's public URL. A failed-output retry reuses the
 * original preparation. The golden plan hash was recomputed independently with Python.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getMiniToolsConfig, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type * as coreModule from "@breatic/core";
import {
  assetRepo, beginMiniToolStepAttempt, miniToolConsumptionRecordSchema, miniToolStepStateSchema, presentationPinService,
  recordMiniToolStepIdentity, taskRepo, upstreamStepRepo,
  type AcceptedMiniToolExecution, type StoredAsset,
} from "@breatic/domain";
import { hashMiniToolValue, videoContainerJobId } from "@breatic/shared/mini-tools";
import * as shared from "@breatic/shared";
import { readFileSync } from "node:fs";
import type { StudioAssetEntity } from "@breatic/shared";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import type * as uploadModule from "@worker/handlers/backend-upload.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { runMiniToolRemoveBackground } from "@worker/handlers/mini-tool/run-remove-background.js";
import { seedStudioFixture, type StudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";

const { runPrediction, storeFromUrl } = vi.hoisted(() => ({
  runPrediction: vi.fn<typeof wavespeedModule.runPrediction>(), storeFromUrl: vi.fn<typeof uploadModule.storeFromUrl>(),
}));
// Today's configuration can differ from what a run froze at admission (§3.2 item 1); WP06 changes the chunk retry cap.
const overrides = vi.hoisted(() => ({ chunkRetries: undefined as number | undefined }));
// WP09 reads what the handlers log; the spy stands in for the core logger in this file.
const log = vi.hoisted(() => { const spy = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() }; spy.child.mockReturnValue(spy); return spy; });
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: log as unknown as typeof actual.logger, getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => {
    const config = actual.getMiniToolsConfig();
    return overrides.chunkRetries === undefined ? config : { ...config, encoding: { ...config.encoding, chunk_retries: overrides.chunkRetries } };
  } };
});
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction }));
vi.mock("@worker/handlers/backend-upload.js", async (original) => ({ ...await original<typeof uploadModule>(), storeFromUrl }));

const PREDICTION = "fixture-prediction-original";
const PROVIDER_URL = "https://provider.example.test/result.webm";
const OUTPUT_HASH = "147d7b46f5062b1cc7231edff71bed11071dd088c5b3434432f24e5d41037a07";
const SOURCE_URL = "https://assets.example.test/video/source.mp4";
const BODY = { video: { kind: "prepared", inputId: "source", job: "50000000-0000-4000-8000-000000000001:prep:0" }, background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true } as const;
// S6d D3b (inner#1306 §91): the worker builds the model-input recipes from the full ledger, so the receipt is that of a real
// full ledger: the container's ledger of a generated 96-frame 320x180 source, bound to source fingerprint aaaa (worker
// fixtures/presentation/PROVENANCE.txt). The fetch fake serves its bytes at the receipt URL.
const LEDGER_BYTES = readFileSync(new URL("../../../worker/src/handlers/__tests__/fixtures/presentation/cfr96-source-a.ledger.json", import.meta.url));
const RECEIPT = {
  schemaVersion: 2, sourceFingerprint: "a".repeat(64), toolInputId: "b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400",
  planSha256: "e7107a03209bc1b3ea4be74b6a6f0e7dd04f0c62431b78560be411c4cda7beb9", producerVersion: 2, attempt: { jobId: "video-presentation:removal-source", deadlineAt: 1900000000000 },
  url: "https://assets.example.test/video/source.mp4.video-source-ledger.b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400.json", etag: "full-etag", size: 1658,
  sha256: "96a73510df6e3319e51e138c0ca8694f96de0881b453074eddd6906f210204ae", contentType: "application/json",
  table: { url: "https://assets.example.test/video/source.mp4.video-presentation-table.b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400.json", sha256: "74c5313481331d9e42c9a8f9b69bff0bed3d0539e36b90020bb1eb5c1a86af74", size: 353, contentType: "application/json", frameCount: 96 },
};
const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
// §91 D3b-10/11: model input places audio by the plan's audio spans.
const AUDIO_SPANS = (JSON.parse(LEDGER_BYTES.toString("utf8")) as { plan: { audioSpans: unknown } }).plan.audioSpans;
const MODEL_TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium" };
const GOLDEN = {
  schemaVersion: 1, tool: "video.remove-bg", taskId: "50000000-0000-4000-8000-000000000001", projectId: "10000000-0000-4000-8000-000000000001", spaceId: "20000000-0000-4000-8000-000000000001",
  targetNodeIds: ["40000000-0000-4000-8000-000000000001"],
  binding: { assetId: "80000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: SOURCE_URL, kind: "video", mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } },
  sourceKey: "video/source.mp4",
  draft: { version: 1, draftId: "60000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000001", source: { nodeId: "30000000-0000-4000-8000-000000000001", canonicalURL: SOURCE_URL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } }, inputs: [], params: {} },
  analysisRefs: [], outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "remove-bg" } }],
  model: "fixture-bria-fibo-video", provider: { provider: "wavespeed", model_id: "bria/fibo/video-background-remover" }, body: BODY,
  presentationRef: { source: { toolInputId: RECEIPT.toolInputId, planSha256: RECEIPT.planSha256 } }, ledgerReceipts: { source: RECEIPT }, versionIds: { source: "e".repeat(64) },
  preparation: { containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
    prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, chunks: [{ start: 0, end: 96 }], chunkRetries: 3,
    // §91 D3b-5: the model input's encode parameters are frozen at admission like the presentation's.
    encode: { crf: 18, preset: "medium" } },
  credits: 35, modelCredits: 30,
  requestFingerprint: "329f16d3751e013600fc7b50f226a6629d74425d96ef234c6e4d1f016a89e725", planFingerprint: "1b8f9aaad5a162facd8d2fa777e4a99b8eda996cc2d218f9dbd172fc4c95d704",
} as unknown as Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>;
interface Fixture extends StudioFixture { plan: Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>; deadlineAt: number; sourceId: string; assetId: string; coverId: string; canonicalURL: string; coverURL: string }
interface TaskRow { status: string; params: { miniToolExecution: AcceptedMiniToolExecution }; result: Record<string, unknown>; billed_at: string | null; billed_credits: number | null }
let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;

/** Inject only dummy external credentials and preserve the existing library configuration owner.
 * @throws {Error} When the injected fixture configuration is invalid.
 */
function configure(multiplier = 1): void {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: String(multiplier), WAVESPEED_API_KEY: "fixture-never-sent", UPLOAD_BASE_URL: "https://assets.example.test",
    INGEST_BASE_URL: "https://ingest.example.test", INGEST_SHARED_SECRET: "fixture-ingest-secret" });
}

beforeAll(async () => {
  configure(); loadLocales(); pg = createPgClient(inject("DATABASE_URL"), { name: "remove-bg-leaf", max: 6 });
  const storage = await getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
});
// The ingest /jobs boundary: every submitted container job is recorded and, unless a case scripts it, done at once.
const jobs = { submitted: [] as Record<string, unknown>[], scripted: new Map<string, Record<string, unknown>>() };
/** A finished job report echoing the request's declared output. @throws {never} Never. */
function doneReport(request: Record<string, unknown>): Record<string, unknown> {
  const output = (request.outputs as { outputIndex: number; storageKey: string; contentType: string }[])[0]!;
  return { schemaVersion: 2, state: "done", outputs: [{ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType }], usage: { wallMs: 1000, cpuUsec: 2000000 } };
}
// The bytes the receipt URL serves; WP07 serves other bytes.
let ledgerBody: Buffer = LEDGER_BYTES;
// A transport failure of the ledger read, before any body (WP08).
let ledgerFault: "reset" | 503 | null = null;
beforeEach(() => {
  ledgerBody = LEDGER_BYTES;
  ledgerFault = null;
  vi.resetAllMocks(); log.child.mockReturnValue(log); configure(); overrides.chunkRetries = undefined;
  jobs.submitted.length = 0; jobs.scripted.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>; jobs.submitted.push(request);
      return Response.json(jobs.scripted.get(String(request.jobId)) ?? doneReport(request));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = jobs.submitted.find((candidate) => candidate.jobId === id);
      if (request === undefined) return new Response("missing", { status: 404 });
      return Response.json(jobs.scripted.get(id) ?? doneReport(request));
    }
    if (url.href === RECEIPT.url) {
      if (ledgerFault === "reset") throw new TypeError("fetch failed: connection reset");
      if (ledgerFault === 503) return new Response("unavailable", { status: 503 });
      return new Response(ledgerBody, { headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  }));
});
afterAll(async () => { await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

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
describe("prepared pins at preparation registration (inner#1306 §90 E4; design §7.15 prepared 行, 释放点)", () => {
  /**
   * The run's live prepared pins with their keys.
   * @param f - The fixture.
   * @returns Rows.
   */
  async function preparedPins(f: Fixture): Promise<{ prepared_key: string | null; tool_input_id: string; keys: string[] }[]> {
    return pg`SELECT p.prepared_key,p.tool_input_id,coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL),'{}') AS keys
      FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
      WHERE p.holder_id=${f.plan.taskId} AND p.holder_kind='prepared' AND p.deleted_at IS NULL GROUP BY p.id`;
  }

  it("PP01 registering the done preparation pins its output for the run", async () => {
    const f = await seed(); completeProvider(); backend(f);
    await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false);
    const key = prepared(f, `${f.plan.taskId}:prep:0:a1`).key;
    expect(await preparedPins(f)).toEqual([{ prepared_key: key, tool_input_id: f.plan.presentationRef.source.toolInputId, keys: [key] }]);
  });

  it("PP05 a provider step due after the deadline ends the run expired and appends no generate step", async () => {
    const f = await seed(); completeProvider(); backend(f);
    const prep = `${f.plan.taskId}:prep:0:a1`;
    jobs.scripted.set(prep, { schemaVersion: 2, state: "running" });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBeInstanceOf(StillRunning);
    // The preparation reports done once the deadline has passed, so the provider step after it is due after the deadline.
    jobs.scripted.delete(prep);
    await expect(runMiniToolRemoveBackground(f.plan.taskId, Date.now() - 1, false)).rejects.toBeInstanceOf(shared.DeadlinePassed);
    expect((await upstreamStepRepo.listSteps(f.plan.taskId)).map((row) => row.kind)).not.toContain("generate");
    expect(runPrediction).not.toHaveBeenCalled();
  });

  // A prediction that completed before the deadline is read by the first pickup after it: storing its result starts no new
  // work, so the output is registered instead of the run ending expired with the provider already charged.
  it("PP06 a prediction completed before the deadline and read by a pickup 1 s after it registers its output", async () => {
    const f = await seed(); completeProvider(); backend(f); await identify(f);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(f.deadlineAt + 1000);
      await winner(f, await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, true));
    } finally { vi.useRealTimers(); }
    expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).toHaveBeenCalledTimes(1);
    expect((await step(f)).output["miniToolAsset:0"]).toBe(f.assetId);
  });

  it("PP02 a chunked preparation pins the stitched object; once the stitch is committed its chunk outputs are registered for reclaim", async () => {
    const f = await seed(); completeProvider(); backend(f);
    const plan = structuredClone(f.plan);
    plan.preparation.chunks = [{ start: 0, end: 48 }, { start: 48, end: 96 }];
    plan.planFingerprint = await planHash(plan);
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.plan.taskId}`;
    for (let pickup = 0; pickup < 4 && runPrediction.mock.calls.length === 0; pickup += 1) {
      await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    }
    const chunk = (k: number): string => prepared(f, videoContainerJobId({ kind: "prep-chunk", taskId: f.plan.taskId, input: 0, chunk: k, attempt: 1 })).key;
    const stitch = prepared(f, videoContainerJobId({ kind: "prep-stitch", taskId: f.plan.taskId, input: 0, attempt: 1 })).key;
    expect(await preparedPins(f)).toEqual([{ prepared_key: stitch, tool_input_id: f.plan.presentationRef.source.toolInputId, keys: [stitch] }]);
    const rows = await pg<{ storage_key: string; kind: string }[]>`SELECT storage_key,kind FROM storage_reclaim_queue WHERE storage_key IN (${chunk(0)},${chunk(1)},${stitch}) ORDER BY storage_key`;
    expect([...rows]).toEqual([chunk(0), chunk(1)].sort().map((storage_key) => ({ storage_key, kind: "derived" })));
  });

  it("PP04 a chunk failed for good waits for a running chunk, which is pinned with the run, and no chunk opens a next attempt after it", async () => {
    const f = await seed(); completeProvider(); backend(f);
    const plan = structuredClone(f.plan);
    plan.preparation.chunks = [{ start: 0, end: 32 }, { start: 32, end: 64 }, { start: 64, end: 96 }];
    plan.planFingerprint = await planHash(plan);
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.plan.taskId}`;
    /**
     * A preparation chunk attempt's job id.
     * @param k - The chunk.
     * @param attempt - The attempt.
     * @returns The id.
     */
    const chunk = (k: number, attempt = 1): string => videoContainerJobId({ kind: "prep-chunk", taskId: f.plan.taskId, input: 0, chunk: k, attempt });
    const failed = { schemaVersion: 2, state: "failed", outputs: [], reason: "tool_failed", usage: { wallMs: 500, cpuUsec: 1000000 } };
    for (const k of [0, 1, 2]) jobs.scripted.set(chunk(k), { schemaVersion: 2, state: "running" });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBeInstanceOf(StillRunning);
    // Chunk 1 fails on every attempt and chunk 2's first attempt fails while chunk 0 still runs: the preparation does not end.
    for (let attempt = 1; attempt <= plan.preparation.chunkRetries + 1; attempt += 1) jobs.scripted.set(chunk(1, attempt), failed);
    jobs.scripted.set(chunk(2), failed);
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBeInstanceOf(StillRunning);
    jobs.scripted.delete(chunk(0));
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBeInstanceOf(UpstreamTaskFailed);
    expect(jobs.submitted.map((request) => request.jobId)).not.toContain(chunk(2, 2));
    expect(runPrediction).not.toHaveBeenCalled();
    const rows = await pg<{ storage_key: string }[]>`SELECT o.storage_key FROM presentation_pins p JOIN presentation_pin_objects o ON o.pin_id=p.id
      WHERE p.holder_kind='execution' AND p.holder_id=${f.plan.taskId} AND p.deleted_at IS NULL`;
    expect(rows.map((row) => row.storage_key)).toContain(prepared(f, chunk(0)).key);
  });

  it("PP03 a failed preparation attempt's output is registered for reclaim; the attempt that succeeded is pinned, not registered (§90 E4-14 b)", async () => {
    const f = await seed(); completeProvider(); backend(f);
    jobs.scripted.set(`${f.plan.taskId}:prep:0:a1`, { schemaVersion: 2, state: "failed", outputs: [], reason: "tool_failed", usage: { wallMs: 500, cpuUsec: 1000000 } });
    for (let pickup = 0; pickup < 3 && runPrediction.mock.calls.length === 0; pickup += 1) {
      await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    }
    const failed = prepared(f, `${f.plan.taskId}:prep:0:a1`).key; const done = prepared(f, `${f.plan.taskId}:prep:0:a2`).key;
    const rows = await pg<{ storage_key: string; kind: string }[]>`SELECT storage_key,kind FROM storage_reclaim_queue WHERE storage_key IN (${failed},${done})`;
    expect([...rows]).toEqual([{ storage_key: failed, kind: "derived" }]);
    expect((await preparedPins(f)).map((row) => row.prepared_key)).toEqual([done]);
  });
});

async function seed(golden = false): Promise<Fixture> {
  expect(await planHash(GOLDEN)).toBe("1b8f9aaad5a162facd8d2fa777e4a99b8eda996cc2d218f9dbd172fc4c95d704");
  const target = await seedStudioFixture(pg, "rb"); const source = await seedStudioFixture(pg, "rs");
  const plan = structuredClone(GOLDEN);
  if (golden) {
    await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${plan.projectId},${target.studioId},${target.userId},${`rb-${randomUUID()}`},'Remove background')`;
  } else {
    plan.taskId = randomUUID(); plan.projectId = target.projectId; plan.spaceId = randomUUID(); plan.binding.assetId = randomUUID();
    plan.draft.draftId = randomUUID(); plan.draft.revision = randomUUID(); plan.draft.source.nodeId = randomUUID();
    plan.targetNodeIds = [randomUUID()]; plan.outputs[0]!.nodeId = plan.targetNodeIds[0]!;
    (plan.body as unknown as { video: { job: string } }).video.job = `${plan.taskId}:prep:0`;
    plan.planFingerprint = await planHash(plan);
  }
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${plan.binding.assetId},${source.studioId},${plan.binding.contentHash},${plan.sourceKey},${SOURCE_URL},4096,'video/mp4','video','upload',${source.userId},960,540,5.055)`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${plan.taskId},${target.userId},${plan.projectId},${plan.spaceId},'video','append','mini_tool','running',${plan.model},${pg.json({ miniToolExecution: { ...plan } })},${pg.json({ kept: { original: true } })})`;
  // Admission writes the run's execution pin with its task (§7.15 execution row); the preparation's chunks are appended to it.
  await presentationPinService.acquire({ holderKind: "execution", holderId: plan.taskId, toolInputId: plan.presentationRef.source.toolInputId,
    objectKeys: presentationPinService.ledgerObjectKeys(plan.sourceKey, plan.presentationRef.source.toolInputId) });
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
  // Preparation steps come first; the one generate descriptor follows them (E3b).
  const rows = (await upstreamStepRepo.listSteps(f.plan.taskId)).filter((row) => row.kind === "generate"); expect(rows).toHaveLength(1);
  const row = rows[0]!; expect(row).toMatchObject({ kind: "generate", endpoint: GOLDEN.provider.model_id, itemIndex: 0 }); return row;
}

/** The output key and public URL of one preparation job: the shared work key and the mp4 extension (§5.4). @throws {Error} When it is missing. */
function prepared(f: Fixture, jobId: string): { key: string; url: string } {
  const keyFor = (shared as Record<string, unknown>).videoPresentationWorkKeyFor as ((storageKey: string, id: string) => string) | undefined;
  expect(keyFor, "videoPresentationWorkKeyFor is exported from @breatic/shared").toBeTypeOf("function");
  const key = `${keyFor!(f.plan.sourceKey, jobId)}.mp4`;
  return { key, url: publicUrl(key) };
}

/** The provider body once the single first-attempt preparation is done: the prepared object's URL in place of the reference. @throws {Error} When the key function is missing. */
function resolvedBody(f: Fixture, jobId = `${f.plan.taskId}:prep:0:a1`): { video: string; background_color: string; output_container_and_codec: string; preserve_audio: boolean } {
  return { ...BODY, video: prepared(f, jobId).url };
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

/** Return the controlled backend receipt that points at a real registered SQL winner; as the real transfer
 * (backend-upload.service.ts transferUrlToStorage), it refuses once the deadline it is given has come.
 * @throws {never} Never.
 */
function backend(f: Fixture, presentationQueueFailed = false): void {
  const stored: StoredAsset = { assetId: f.assetId, fileUrl: f.canonicalURL, kind: "video", coverUrl: f.coverURL, width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436, ...(presentationQueueFailed ? { presentationQueueFailed: true } : {}) };
  storeFromUrl.mockImplementation(async (_url, ctx) => { shared.assertBeforeDeadline(ctx.deadlineAt); return stored; });
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
  expect((await beginMiniToolStepAttempt({ taskId: f.plan.taskId, stepId: owned.id, attemptId, requestBody: resolvedBody(f), deadlineAt: f.deadlineAt, chargeTo: "user" })).shouldSubmit).toBe(true);
  if (prediction) await recordMiniToolStepIdentity({ taskId: f.plan.taskId, stepId: owned.id, attemptId, predictionId: PREDICTION });
  return { stepId: owned.id, attemptId };
}

describe("SQL frozen removal execution and provider persistence", () => {
  it("S04-S05 saves intent before the adapter and identity plus pending consumption before its controlled question", async () => {
    const f = await seed(true); const waiting = new StillRunning(Date.now() + 1000); let observedQuestion = false;
    runPrediction.mockImplementation(async (_connection, model, body, resume) => {
      expect(model).toBe("bria/fibo/video-background-remover"); expect(body).toEqual(resolvedBody(f));
      expect(resume).toMatchObject({ storedTaskId: null, deadlineAt: f.deadlineAt, retryStarting: false });
      const before = await step(f); const intent = miniToolStepStateSchema.parse(before.output.miniToolStep);
      expect(intent).toMatchObject({ requestBody: resolvedBody(f), deadlineAt: f.deadlineAt, chargeTo: "user", creditMultiplier: 1 });
      expect(intent.attempts).toHaveLength(1); expect(intent.attempts[0]!.resolution).toEqual({ kind: "unresolved" });
      expect(before.output.miniToolConsumption).toBeUndefined();
      await resume.persistTaskId(PREDICTION);
      const after = await step(f); expect(after).toMatchObject({ id: before.id, status: "submitted", predictionId: PREDICTION });
      const consumption = miniToolConsumptionRecordSchema.parse(after.output.miniToolConsumption);
      expect(consumption).toMatchObject({ identity: { kind: "provider", provider: "wavespeed", predictionId: PREDICTION }, state: "pending", chargeTo: "user", creditMultiplier: 1, costUsd: null, credits: null });
      // The preparation step's container consumption is opened with its job and priced later, like every container step (§7.6; execution design §6.22).
      const preparationKeys = (await upstreamStepRepo.listSteps(f.plan.taskId)).filter((row) => row.kind === "container_job")
        .map((row) => miniToolConsumptionRecordSchema.parse(row.output.miniToolConsumption).consumptionKey);
      expect(preparationKeys).toHaveLength(1);
      const settlement = (await parent(f)).result.settlement as { consumptionSetComplete: boolean; pendingConsumptionKeys: string[] };
      expect(settlement.consumptionSetComplete).toBe(false);
      expect([...settlement.pendingConsumptionKeys].sort()).toEqual([consumption.consumptionKey, ...preparationKeys].sort());
      observedQuestion = true; throw waiting;
    });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBe(waiting);
    expect(observedQuestion).toBe(true); expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("S06 queries only the stored prediction with the original body, policy and step deadline", async () => {
    const f = await seed(); const owned = await identify(f); const waiting = new StillRunning(Date.now() + 1000); const before = await step(f); configure(2);
    runPrediction.mockImplementation(async (_connection, model, body, resume) => {
      expect(model).toBe(GOLDEN.provider.model_id); expect(body).toEqual(resolvedBody(f)); expect(resume.storedTaskId).toBe(PREDICTION); expect(resume.deadlineAt).toBe(f.deadlineAt); throw waiting;
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
    expect((await beginMiniToolStepAttempt({ taskId: f.plan.taskId, stepId: held.stepId, attemptId: held.attemptId, requestBody: resolvedBody(f), deadlineAt: f.deadlineAt, chargeTo: "user" })).shouldSubmit).toBe(false);
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
    expect(storeFromUrl).toHaveBeenCalledExactlyOnceWith(PROVIDER_URL, { projectId: f.plan.projectId, actingUserId: f.userId, generationTaskId: f.plan.taskId, assetSource: "ai", taskType: "video", ext: ".webm", contentType: "video/webm",
      // Storing the finished prediction is bounded by the read bound: the reporting window (two polls past the deadline) here.
      deadlineAt: f.deadlineAt + 2 * getMiniToolsConfig().poll_interval_ms, knownAlpha: true });
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
    const f = await seed(); const changed = structuredClone(f.plan); (changed.body as unknown as { video: unknown }).video = "https://provider.example.test/replaced.mp4";
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

describe("model-input preparation before generate (inner#1306 §90 E3b; design §5.3, §5.4 作业身份, §7.1.1, §7.11)", () => {
  /**
   * The prepare_model_input requests submitted for this run.
   * @param f - The fixture.
   * @returns Their requests.
   */
  function preparations(f: Fixture): Record<string, unknown>[] {
    return jobs.submitted.filter((request) => String(request.jobId).startsWith(`${f.plan.taskId}:prep:`));
  }

  it("WP01 the single preparation runs first on standard-4 under its §5.4 id, then generate receives the prepared object's URL", async () => {
    const f = await seed(); completeProvider(); backend(f);
    await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false);
    const id = `${f.plan.taskId}:prep:0:a1`;
    const [request] = preparations(f);
    expect(preparations(f)).toHaveLength(1);
    expect(request).toMatchObject({ jobId: id, containerClass: "MiniToolContainerStd4", inputs: [{ storageKey: f.plan.sourceKey }] });
    const output = (request!.outputs as { storageKey: string; recipe: Record<string, unknown> }[])[0]!;
    expect(output.storageKey).toBe(prepared(f, id).key);
    // §5.3 model-input row, §91 D3-4: the selected interval's spans from the full ledger, the display geometry (even sides, no
    // carrier cap), the plan matrix, SDR, opaque, the frozen encode parameters and the interval's audio.
    expect(output.recipe).toEqual({ kind: "prepare_model_input", inputId: (request!.inputs as { inputId: string }[])[0]!.inputId, window: { start: 0, end: 96 }, timescale: 25,
      entries: [{ kind: "source", decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(96, 25), rate: r(1) }], target: MODEL_TARGET, audio: { start: r(0), end: r(96, 25), origin: r(0), spans: AUDIO_SPANS } });
    expect(runPrediction).toHaveBeenCalledTimes(1);
    expect(runPrediction.mock.calls[0]![2]).toEqual(resolvedBody(f, id));
    const rows = await upstreamStepRepo.listSteps(f.plan.taskId);
    const generate = rows.find((row) => row.kind === "generate")!;
    expect(rows.filter((row) => row.kind === "container_job").every((row) => row.position < generate.position)).toBe(true);
    expect(rows.some((row) => row.kind === "container_job" && row.endpoint === "MiniToolContainerStd4")).toBe(true);
  });

  it("WP02 a preparation still running keeps the run waiting and nothing reaches the provider", async () => {
    const f = await seed(); completeProvider(); backend(f);
    jobs.scripted.set(`${f.plan.taskId}:prep:0:a1`, { schemaVersion: 2, state: "running" });
    await expect(runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false)).rejects.toBeInstanceOf(StillRunning);
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });

  it("WP03 a failed preparation attempt is retried under the next attempt's id and key, and generate uses that attempt's output", async () => {
    const f = await seed(); completeProvider(); backend(f);
    jobs.scripted.set(`${f.plan.taskId}:prep:0:a1`, { schemaVersion: 2, state: "failed", outputs: [], reason: "tool_failed", usage: { wallMs: 500, cpuUsec: 1000000 } });
    for (let pickup = 0; pickup < 3 && runPrediction.mock.calls.length === 0; pickup += 1) {
      await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    }
    expect(preparations(f).map((request) => request.jobId)).toEqual([`${f.plan.taskId}:prep:0:a1`, `${f.plan.taskId}:prep:0:a2`]);
    expect(prepared(f, `${f.plan.taskId}:prep:0:a2`).key).not.toBe(prepared(f, `${f.plan.taskId}:prep:0:a1`).key);
    expect(runPrediction.mock.calls[0]![2]).toEqual(resolvedBody(f, `${f.plan.taskId}:prep:0:a2`));
  });

  it("WP04 a preparation over one chunk share runs as chunk_encode jobs plus a stitch, and generate uses the stitched object", async () => {
    const f = await seed(); completeProvider(); backend(f);
    const plan = structuredClone(f.plan);
    plan.preparation.chunks = [{ start: 0, end: 48 }, { start: 48, end: 96 }];
    plan.planFingerprint = await planHash(plan);
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.plan.taskId}`;
    for (let pickup = 0; pickup < 4 && runPrediction.mock.calls.length === 0; pickup += 1) {
      await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    }
    const chunk = (k: number): string => videoContainerJobId({ kind: "prep-chunk", taskId: f.plan.taskId, input: 0, chunk: k, attempt: 1 });
    const stitch = videoContainerJobId({ kind: "prep-stitch", taskId: f.plan.taskId, input: 0, attempt: 1 });
    expect(preparations(f).map((request) => request.jobId)).toEqual([chunk(0), chunk(1), stitch]);
    const recipes = preparations(f).map((request) => (request.outputs as { recipe: Record<string, unknown> }[])[0]!.recipe);
    const source = (preparations(f)[0]!.inputs as { inputId: string }[])[0]!.inputId;
    expect(recipes[0]).toEqual({ kind: "chunk_encode", inputId: source, window: { start: 0, end: 48 }, timescale: 25, target: MODEL_TARGET,
      entries: [{ kind: "source", decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(48, 25), rate: r(1) }] });
    expect(recipes[1]).toEqual({ kind: "chunk_encode", inputId: source, window: { start: 48, end: 96 }, timescale: 25, target: MODEL_TARGET,
      entries: [{ kind: "source", decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(96, 25), rate: r(1) }] });
    // §91 D3-2: the chunks are bound inputs of the stitch, each for its plan duration.
    const inputs = preparations(f)[2]!.inputs as { inputId: string; storageKey: string }[];
    expect(inputs.map((input) => input.storageKey)).toEqual([f.plan.sourceKey, prepared(f, chunk(0)).key, prepared(f, chunk(1)).key]);
    expect(recipes[2]).toEqual({ kind: "stitch", inputId: inputs[0]!.inputId, chunks: [{ inputId: inputs[1]!.inputId, duration: r(48, 25) }, { inputId: inputs[2]!.inputId, duration: r(48, 25) }],
      audio: { start: r(0), end: r(96, 25), origin: r(0), spans: AUDIO_SPANS }, target: MODEL_TARGET });
    expect(runPrediction.mock.calls[0]![2]).toEqual(resolvedBody(f, stitch));
  });

  it("WP05 a failed-output retry reuses the original preparation: no new preparation job, the original prepared URL", async () => {
    const f = await seed(); completeProvider(); backend(f);
    await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false);
    const retry = structuredClone(f.plan) as typeof f.plan & { retry: { runId: string; outputIndexes: number[] } };
    retry.taskId = randomUUID(); retry.retry = { runId: f.plan.taskId, outputIndexes: [0] };
    retry.planFingerprint = await planHash(retry);
    await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
      VALUES (${retry.taskId},${f.userId},${retry.projectId},${retry.spaceId},'video','append','mini_tool','running',${retry.model},${pg.json({ miniToolExecution: { ...retry } })},${pg.json({})})`;
    jobs.submitted.length = 0; runPrediction.mockClear();
    await runMiniToolRemoveBackground(retry.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    expect(jobs.submitted).toEqual([]);
    expect(runPrediction.mock.calls[0]![2]).toEqual(resolvedBody(f, `${f.plan.taskId}:prep:0:a1`));
  });

  // frames-split retry row: a retry of a run that never finished preparing is admitted with its own preparation named in
  // its body (planned-mini-tool-admission A19), so it prepares under its own task and then generates.
  it("WP11 a retry whose original never finished preparing prepares under its own task, then generate uses that object", async () => {
    const f = await seed(); completeProvider(); backend(f);
    // The original's only preparation attempts failed: it has no done preparation to reuse.
    for (let attempt = 1; attempt <= f.plan.preparation.chunkRetries + 1; attempt += 1) {
      jobs.scripted.set(`${f.plan.taskId}:prep:0:a${attempt}`, { schemaVersion: 2, state: "failed", outputs: [], reason: "tool_failed", usage: { wallMs: 500, cpuUsec: 1000000 } });
    }
    for (let pickup = 0; pickup < 4; pickup += 1) {
      const ended = await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).then(() => false, (error: unknown) => { if (error instanceof StillRunning) return false; return true; });
      if (ended) break;
    }
    expect(runPrediction).not.toHaveBeenCalled();
    const retry = structuredClone(f.plan) as typeof f.plan & { retry: { runId: string; outputIndexes: number[] } };
    retry.taskId = randomUUID(); retry.retry = { runId: f.plan.taskId, outputIndexes: [0] };
    (retry.body as unknown as { video: { job: string } }).video.job = `${retry.taskId}:prep:0`;
    retry.planFingerprint = await planHash(retry);
    await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
      VALUES (${retry.taskId},${f.userId},${retry.projectId},${retry.spaceId},'video','append','mini_tool','running',${retry.model},${pg.json({ miniToolExecution: { ...retry } })},${pg.json({})})`;
    jobs.submitted.length = 0;
    for (let pickup = 0; pickup < 3 && runPrediction.mock.calls.length === 0; pickup += 1) {
      await runMiniToolRemoveBackground(retry.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    }
    expect(jobs.submitted.map((request) => request.jobId)).toEqual([`${retry.taskId}:prep:0:a1`]);
    expect(runPrediction).toHaveBeenCalledTimes(1);
    expect(runPrediction.mock.calls[0]![2]).toEqual(resolvedBody({ ...f, plan: retry }, `${retry.taskId}:prep:0:a1`));
  });

  // §91 D3b-9 (design §7.4 Check, §10.6 失败分类): the frozen receipt cannot change within the run, so a full ledger that
  // fails it is a deterministic `source_ledger_invalid` (transient class: a new run freezes the repaired ledger). The run
  // fails at once instead of polling to the two-hour deadline; nothing is prepared and the provider is not reached.
  it("WP07 a full ledger that fails its frozen receipt fails the run as source_ledger_invalid without preparing or generating", async () => {
    const f = await seed(); completeProvider(); backend(f);
    ledgerBody = Buffer.concat([LEDGER_BYTES, Buffer.from(" ")]);
    const failure = await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(UpstreamTaskFailed);
    expect(`${(failure as UpstreamTaskFailed).message} ${(failure as UpstreamTaskFailed).upstreamError}`).toContain("source_ledger_invalid");
    expect(preparations(f)).toEqual([]);
    expect(runPrediction).not.toHaveBeenCalled();
  });

  // §91 D3b-9: a transport failure is not a content mismatch: the run is not failed and keeps its normal transient retry.
  it.each([["a connection reset", "reset"], ["a 503 before any body", 503]] as const)("WP08 %s reading the full ledger leaves the run running and retried; the next read prepares", async (_name, fault) => {
    const f = await seed(); completeProvider(); backend(f);
    ledgerFault = fault;
    const failure = await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).then(() => null, (error: unknown) => error);
    expect(failure).not.toBeNull();
    expect(failure).not.toBeInstanceOf(UpstreamTaskFailed);
    expect(preparations(f)).toEqual([]);
    expect((await parent(f)).status).toBe("running");
    ledgerFault = null;
    await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    expect(preparations(f)).toHaveLength(1);
  });

  // §91 D3b mutation P2: the catch that fails the run logs it (root AGENTS.md "Application-layer error logging").
  it("WP09 a full ledger that fails its frozen receipt is logged with the run's taskId and toolInputId", async () => {
    const f = await seed(); completeProvider(); backend(f);
    ledgerBody = Buffer.concat([LEDGER_BYTES, Buffer.from(" ")]);
    await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch(() => undefined);
    expect([...log.error.mock.calls]).toContainEqual([expect.objectContaining({ ctx: expect.objectContaining({ taskId: f.plan.taskId, toolInputId: f.plan.presentationRef.source.toolInputId }) }), expect.any(String)]);
  });

  // §91 D3b mutation W15 (§91 D3b-11): the model input's audio carries the plan's origin.
  it("WP10 a ledger whose origin is not 0 gives a model input whose audio carries that origin", async () => {
    const f = await seed(); completeProvider(); backend(f);
    const ledger = JSON.parse(LEDGER_BYTES.toString("utf8")) as { sourceFingerprint: string; toolInputId: string; planSha256: string; plan: { originMapping: { origin: unknown } } };
    ledger.plan.originMapping.origin = r(1, 4);
    ledger.planSha256 = await (shared as unknown as { videoPresentationPlanSha256: (value: unknown) => Promise<string> }).videoPresentationPlanSha256(ledger.plan);
    ledger.toolInputId = await (shared as unknown as { videoPresentationToolInputId: (value: { sourceFingerprint: string; planSha256: string }) => Promise<string> }).videoPresentationToolInputId({ sourceFingerprint: ledger.sourceFingerprint, planSha256: ledger.planSha256 });
    ledgerBody = Buffer.from(`${JSON.stringify(ledger)}\n`);
    const plan = structuredClone(f.plan);
    plan.ledgerReceipts.source = { ...plan.ledgerReceipts.source, toolInputId: ledger.toolInputId, planSha256: ledger.planSha256, size: ledgerBody.byteLength,
      sha256: createHash("sha256").update(ledgerBody).digest("hex") };
    plan.presentationRef.source = { toolInputId: ledger.toolInputId, planSha256: ledger.planSha256 };
    plan.planFingerprint = await planHash(plan);
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.plan.taskId}`;
    await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch((error: unknown) => { if (!(error instanceof StillRunning)) throw error; });
    const recipe = (preparations(f)[0]!.outputs as { recipe: { audio: { origin: unknown } } }[])[0]!.recipe;
    expect(recipe.audio.origin).toEqual(r(1, 4));
  });

  it("WP06 the preparation retry cap is the one frozen at admission, not today's encoding.chunk_retries", async () => {
    const f = await seed(); completeProvider(); backend(f);
    const plan = structuredClone(f.plan);
    (plan as unknown as { preparation: { chunkRetries: number } }).preparation.chunkRetries = 1;
    plan.planFingerprint = await planHash(plan);
    await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.plan.taskId}`;
    overrides.chunkRetries = 3;
    for (const attempt of [1, 2, 3, 4]) {
      jobs.scripted.set(`${f.plan.taskId}:prep:0:a${attempt}`, { schemaVersion: 2, state: "failed", outputs: [], reason: "tool_failed", usage: { wallMs: 500, cpuUsec: 1000000 } });
    }
    for (let pickup = 0; pickup < 6; pickup += 1) {
      await runMiniToolRemoveBackground(f.plan.taskId, f.deadlineAt, false).catch(() => undefined);
    }
    expect(preparations(f).map((request) => request.jobId)).toEqual([`${f.plan.taskId}:prep:0:a1`, `${f.plan.taskId}:prep:0:a2`]);
    expect(runPrediction).not.toHaveBeenCalled();
  });
});

