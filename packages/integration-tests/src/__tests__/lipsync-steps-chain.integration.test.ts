// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lip-sync step bodies after `track` submits, run whole through the real runner `runMiniToolLipSync` and the real
 * `runLipSyncStep` (inner#1306 test plan §97 D21; execution design §9.1–§9.4; multi-person lip-sync DD §7.1, §7.2;
 * frames-split §5.4 派发/预算/上限 rows, §7.15, §7.17 recipe rows and the paragraph after the table).
 *
 * Real PostgreSQL steps, attempts, grants, pins and registration. The controlled external IO: WaveSpeed `runPrediction`;
 * the ingest Worker's link fetch `fetchUrlToIngest` (lane ③, which `transferUrlToDerived` uses, §97 D21-1); the ingest
 * `/jobs` boundary and the stored full ledger, faked at `fetch` (every job done at once unless a case scripts it).
 *
 * What is asserted, all at those boundaries or in SQL:
 * - track (execution design §10.2): the anchor at frame 12 of the used frames [0, 50) gives the shared `prepare:fwd` over
 *   [12, 50) and `prepare:rev` over [0, 12] reversed; each person tracks both clips with its box on their frame 0, each
 *   SAM3 `rle_url` is fetched into the derived key `${stepKeys["track:fwd" | "track:rev"]}:${attemptId}` (the step's
 *   `MiniToolStepAttempt.attemptId`), pinned on the run's execution pin, with no `studio_assets` row (D21-1).
 * - faces, clip, stem, composite: standard-4 container jobs with the §7.17 recipes (shapes of §97 D20-1), their job ids
 *   built from the step key and an attempt ordinal and their outputs at `videoPresentationWorkKeyFor(sourceKey, jobId)`
 *   followed by the extension of the type they hold (D21-2), each output pinned and not registered; per stage no more first-attempt jobs than the frozen `stageJobs`.
 * - gen: one prediction to the frozen `generator.modelId` (provider `sync/lipsync-3`) with exactly the person video and
 *   stem URLs, `sync_mode: "cut_off"` only for `providerSyncMode: "cut_off"`; its result URL fetched into
 *   `${stepKeys.gen}:${attemptId}` and pinned; a 400 or 422 on submit, or the model's configured `async_rejection`, is
 *   `model_rejected` in the one §9.4 reason.
 * - stitch: one job over the composite chunks whose audio is `{ kind: "mix", inputs: [each stem] }` (§97 D22-3); the
 *   run's one output is registered.
 * - retry (D21-6): a retry of a run whose person 1 succeeded and person 3's gen timed out reuses every done step by its
 *   frozen step key: only person 3's gen is submitted, person 1 adds no consumption, no preparation or per-person
 *   container job runs again.
 *
 * Fixture choices (recorded in §97): the audio keys of the stem come from the draft's audio inputs (the frozen dialogues
 * carry `audioInputId` only); the model's `async_rejection` is read from today's lip-sync configuration by
 * `generator.modelId`.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getMiniToolsConfig, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type * as coreModule from "@breatic/core";
import { lipsyncPersonStepKeys, lipsyncSharedStepKeys, miniToolStepStateSchema, presentationPinService, taskRepo, upstreamStepRepo } from "@breatic/domain";
import type * as sharedModule from "@breatic/shared";
import type * as domainModule from "@breatic/domain";
import { DeadlinePassed, isUploadableMediaType, miniToolPlanJobRequestSchema, sniffMimeType, UploadHttpError, verifyUploadTicket, videoPresentationWorkKeyFor } from "@breatic/shared";
import { lipsyncFailureReasonSchema, plannedStageJobs, trackingClips } from "@breatic/shared/mini-tools";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { lipsyncStepKey } from "@worker/handlers/mini-tool/lipsync-steps.js";
import { stepObjectKey } from "@worker/handlers/mini-tool/model-run-steps.js";
import { seedStudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { INGEST_ENV } from "./ingest-jobs-fake.js";

const outside = vi.hoisted(() => ({ runPrediction: vi.fn(), fetchUrl: vi.fn(), config: { rejection: { path: "error.code", equals: "lipsync_input_rejected" } }, rename: false }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction: outside.runPrediction }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(), fetchUrlToIngest: outside.fetchUrl }));
// §97 D25-8: the model catalog the worker reads; a case renames the upstream fields the yaml declares for SAM3 and sync-3.
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, getFullModelConfig: (kind: Parameters<typeof actual.getFullModelConfig>[0]): ReturnType<typeof actual.getFullModelConfig> => {
    const config = actual.getFullModelConfig(kind);
    if (!outside.rename || kind !== "video") return config;
    const renamed = structuredClone(config);
    const params = (name: string): Record<string, Record<string, unknown>> => renamed.models.find((model) => model.name === name)!.params as Record<string, Record<string, unknown>>;
    const sam3 = params("sam3-video-rle");
    for (const [name, upstream] of [["video", "source_video"], ["box_prompts", "boxes"], ["apply_mask", "mask_preview"]] as const) sam3[name] = { ...sam3[name], upstream };
    const sync = params("sync-lipsync-3");
    for (const [name, upstream] of [["video", "input_video"], ["audio", "input_audio"]] as const) sync[name] = { ...sync[name], upstream };
    sync.sync_mode = { ...(sync.sync_mode ?? { default: null, fill: "none" }), upstream: "mode" };
    return renamed;
  } };
});
// Today's configuration offers lip-sync with sync-3 and the asynchronous rejection field its measurement found (§9.3).
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => {
    const config = structuredClone(actual.getMiniToolsConfig());
    // Today's share differs from the one the fixture's plan froze, so a job built from live configuration would show it.
    config.encoding.raw_disk_share = 0.25;
    Reflect.set(config.executions, "video.lip-sync", { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1, max_outputs_per_job: 1,
      models: [{ name: "sync-lipsync-3", schema_fingerprint: "1".repeat(64), min_duration_seconds: 1, max_duration_seconds: 300, crop_size: 512, accepts_sync_mode: true,
        async_rejection: outside.config.rejection }],
      tracking: { model: "sam3-video-rle" }, max_people: 2, max_dialogues: 8, face_feather: 0.1 });
    return config;
  } };
});

// The budget the fixture's plan froze at admission: half of standard-4's 20 GB disk.
const FROZEN_RAW_DISK_BYTES = 10_000_000_000;
// The face feather the fixture's plan froze, unlike today's configured one.
const FROZEN_FACE_FEATHER = 0.3;
type LipSync = (execution: unknown, userId: string, deadlineAt: number) => Promise<{ results: Map<number, Record<string, unknown>>; waiting: boolean }>;
const RUNNER = "@worker/handlers/mini-tool/run-lip-sync.js";
/** The real runner, loaded by name. @returns It. */
const runner = async (): Promise<LipSync> => ((await import(/* @vite-ignore */ RUNNER)) as { runMiniToolLipSync: LipSync }).runMiniToolLipSync;

const TRACKER = "wavespeed-ai/sam3-video-rle";
const GENERATOR = "sync/lipsync-3";
const PLAN = "d".repeat(64);
const SOURCE_KEY = "video/source.mp4";
const LEDGER = readFileSync(new URL("../../../worker/src/handlers/__tests__/fixtures/presentation/cfr96-source-a.ledger.json", import.meta.url));
const RECEIPT = {
  schemaVersion: 2, sourceFingerprint: "a".repeat(64), toolInputId: "b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400",
  planSha256: "e7107a03209bc1b3ea4be74b6a6f0e7dd04f0c62431b78560be411c4cda7beb9", producerVersion: 2, attempt: { jobId: "video-presentation:removal-source", deadlineAt: 1900000000000 },
  url: "https://assets.example.test/video/source.mp4.video-source-ledger.b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400.json", etag: "full-etag", size: 1658,
  sha256: "96a73510df6e3319e51e138c0ca8694f96de0881b453074eddd6906f210204ae", contentType: "application/json",
  table: { url: "https://assets.example.test/video/source.mp4.video-presentation-table.b47c17c2e0e9c3715cebc026006b16df079b09d13ba26e3469e27f51a765f400.json", sha256: "74c5313481331d9e42c9a8f9b69bff0bed3d0539e36b90020bb1eb5c1a86af74", size: 353, contentType: "application/json", frameCount: 96 },
};
const PEOPLE = ["person-1", "person-3"] as const;
type Person = (typeof PEOPLE)[number];
const BOX_X: Record<number, Person> = { 80: "person-1", 200: "person-3" };
const LAYOUT = { preparation: [{ start: 0, end: 50 }], persons: 2, composite: [{ start: 0, end: 25 }, { start: 25, end: 50 }], tracking: { forward: [{ start: 12, end: 50 }], reverse: [{ start: 0, end: 13 }] } };
// Both people's anchor is frame 12 of the used frames [0, 50): a forward clip [12, 50) and a reversed one [0, 12].
const CLIPS = trackingClips({ start: 0, end: 50 }, 12);

type Exact = { numerator: string; denominator: string };
/**
 * An exact recipe time in seconds.
 * @param value - The rational.
 * @returns Its value.
 */
const seconds = (value: Exact): number => Number(value.numerator) / Number(value.denominator);
interface Job { jobId: string; containerClass: string; inputs: { inputId: string; storageKey: string }[]; outputs: { outputIndex: number; storageKey: string; contentType: string; recipe: Record<string, unknown> }[] }
interface Fixture { execution: Record<string, unknown> & { taskId: string; persons: { personId: Person; stepKeys: Record<string, string> }[] }; userId: string; deadlineAt: number; audioKeys: Record<Person, string[]> }

let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;
let submitted: Job[];
let jsonType: string;
let scripted: Map<string, Record<string, unknown>>;
// Per-person provider behaviour of the generation submit.
let genFault: Partial<Record<Person, unknown>>;
// Container jobs a case makes fail on every attempt.
let failJob: (request: Job) => boolean;
// The full ledger bytes the stored-ledger fetch serves; a case may serve a variant with a receipt measuring it.
let ledgerBytes: Buffer;

/** Inject dummy external credentials only. @throws {Error} On invalid fixture configuration. */
function configure(): void {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "fixture-never-sent", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
}

/**
 * A done report for a job: every declared output written, with measured media numbers for a video.
 * @param request - The job.
 * @returns The report.
 */
function done(request: Job): Record<string, unknown> {
  // The Worker measures each written output by its bytes and fails the job when that differs from the planned type
  // (ingest job-write.ts); a faces table and a joined RLE are JSON text.
  if (request.outputs.some((output) => (output.recipe.kind === "lipsync_faces" || output.recipe.kind === "rle_join") && output.contentType !== jsonType)) {
    return { schemaVersion: 2, state: "failed", reason: "internal", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } };
  }
  return { schemaVersion: 2, state: "done", usage: { wallMs: 1000, cpuUsec: 2000000 }, outputs: request.outputs.map((output) => ({
    outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType,
    ...(output.contentType.startsWith("video/") ? { width: 320, height: 180, durationSeconds: 2, cover: null, upright: null } : {}) })) };
}

/**
 * A failed report with no output.
 * @returns The report.
 */
function failedReport(): Record<string, unknown> {
  return { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } };
}

beforeAll(async () => {
  configure(); loadLocales(); pg = createPgClient(inject("DATABASE_URL"), { name: "lipsync-chain", max: 6 });
  jsonType = await sniffMimeType(new TextEncoder().encode('{"frames":[]}'));
  const storage = await getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => {
  vi.clearAllMocks(); configure();
  submitted = []; scripted = new Map(); genFault = {}; failJob = () => false; ledgerBytes = LEDGER;
  outside.config.rejection = { path: "error.code", equals: "lipsync_input_rejected" };
  outside.rename = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Job; submitted.push(request);
      return Response.json(scripted.get(request.jobId) ?? (failJob(request) ? failedReport() : done(request)));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = submitted.find((candidate) => candidate.jobId === id);
      return request === undefined ? new Response("missing", { status: 404 }) : Response.json(scripted.get(id) ?? (failJob(request) ? failedReport() : done(request)));
    }
    if (url.pathname.includes(".video-source-ledger.")) return new Response(ledgerBytes, { headers: { "content-type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }));
  outside.runPrediction.mockImplementation(async (_connection: unknown, model: string, body: Record<string, unknown>, resume: { storedTaskId: string | null; persistTaskId: (id: string) => Promise<void> }) => {
    const id = resume.storedTaskId ?? randomUUID();
    if (model === TRACKER) {
      // The provider reads the endpoint's field names: the renamed ones when a case renames them (LU01).
      const person = BOX_X[(((outside.rename ? body.boxes : body.box_prompts) as { x_min: number }[])[0]!).x_min]!;
      const direction = directionOfClip(String(outside.rename ? body.source_video : body.video));
      if (resume.storedTaskId === null) await resume.persistTaskId(id);
      return { taskId: id, outputs: [{ rle_url: `https://provider.example.test/rle/${person}-${direction}.json`, video_url: `https://provider.example.test/preview/${person}.mp4` }] };
    }
    const person = personOfClip(String(outside.rename ? body.input_video : body.video));
    if (person !== null && genFault[person] !== undefined) throw genFault[person];
    if (resume.storedTaskId === null) await resume.persistTaskId(id);
    return { taskId: id, outputs: [`https://provider.example.test/gen/${person ?? "unknown"}.mp4`] };
  });
  // The Worker's finish rule: it names the stored object by its bytes, and refuses bytes that are neither uploadable nor
  // the type the ticket signed. An RLE answer is JSON text, which reads as plain text.
  outside.fetchUrl.mockImplementation(async (sourceUrl: string, target: { ticket: string }) => {
    const verified = await verifyUploadTicket(target.ticket, INGEST_ENV.INGEST_SHARED_SECRET, Date.now());
    if (!verified.ok) throw new UploadHttpError(401);
    const stored = sourceUrl.endsWith(".json") ? await sniffMimeType(new TextEncoder().encode('["61b00f00jN117"]')) : "video/mp4";
    if (!isUploadableMediaType(stored) && stored !== verified.payload.contentType) throw new UploadHttpError(415, "unsupported_type");
    return { sha256: "8".repeat(64), sizeBytes: 4096, contentType: stored };
  });
});
afterAll(async () => { await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

/**
 * The person whose clip job wrote the object at a URL.
 * @param url - A public URL.
 * @returns The person, or null.
 */
function personOfClip(url: string): Person | null {
  for (const job of submitted) {
    const output = job.outputs[0];
    if (output?.recipe.kind === "lipsync_clip" && publicUrl(output.storageKey) === url) return personOfJob(job);
  }
  return null;
}

/**
 * The tracking clip whose preparation wrote the object at a URL.
 * @param url - A public URL.
 * @returns The clip's direction, or "unknown".
 */
function directionOfClip(url: string): string {
  const job = submitted.find((candidate) => candidate.outputs[0]?.recipe.kind === "prepare_model_input" && publicUrl(candidate.outputs[0].storageKey) === url);
  return String(job?.outputs[0]?.recipe.order ?? "unknown");
}

/**
 * The person a per-person container job belongs to, by the person's frozen step keys in its job id.
 * @param job - The job.
 * @returns The person, or null for a shared job.
 */
function personOfJob(job: Job): Person | null {
  for (const person of PEOPLE) for (const kind of ["track_join", "faces", "clip", "stem"]) if (job.jobId.includes(lipsyncStepKey(PLAN, person, kind))) return person;
  return null;
}

/**
 * A running lip-sync parent and its frozen run, with its execution pin as admission writes it: two people, a 2 s cut_off
 * timeline over frames [0, 50) of the cfr96 source, two composite chunks.
 * @param overrides - Fields replacing the frozen run's.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure.
 */
async function seed(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "lipsync-chain");
  const taskId = randomUUID(); const nodeId = randomUUID(); const spaceId = randomUUID();
  const audio = { "person-1": [randomUUID()], "person-3": [randomUUID(), randomUUID()] } as Record<Person, string[]>;
  const audioKeys = { "person-1": audio["person-1"].map((id) => `audio/lipsync/${id}.mp3`), "person-3": audio["person-3"].map((id) => `audio/lipsync/${id}.mp3`) };
  for (const key of [...audioKeys["person-1"], ...audioKeys["person-3"]]) {
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,duration_seconds)
      VALUES (${randomUUID()},${target.studioId},${randomUUID().replaceAll("-", "").padEnd(64, "0")},${key},${publicUrl(key)},2048,'audio/mpeg','audio','upload',${target.userId},1)`;
  }
  const inputIds = { "person-1": [randomUUID()], "person-3": [randomUUID(), randomUUID()] } as Record<Person, string[]>;
  const execution = {
    schemaVersion: 1, tool: "video.lip-sync", taskId, projectId: target.projectId, spaceId, targetNodeIds: [nodeId],
    binding: { assetId: randomUUID(), contentHash: "a".repeat(64), canonicalURL: publicUrl(SOURCE_KEY), kind: "video", mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
    sourceKey: SOURCE_KEY,
    draft: { inputs: PEOPLE.flatMap((person) => inputIds[person].map((inputId, index) => ({ inputId, url: publicUrl(audioKeys[person][index]!), mediaInfo: { duration: 1, mimeType: "audio/mpeg" } }))) },
    analysisRefs: [], outputs: [{ outputIndex: 0, nodeId, recipe: { kind: "lip-sync" } }],
    model: "sync-lipsync-3", credits: 40, requestFingerprint: "c".repeat(64), planFingerprint: PLAN,
    presentationRef: { source: { toolInputId: RECEIPT.toolInputId, planSha256: RECEIPT.planSha256 } }, ledgerReceipts: { source: RECEIPT }, versionIds: { source: "e".repeat(64) },
    generator: { backend: "wavespeed-crop", modelId: "sync-lipsync-3", schemaFingerprint: "1".repeat(64), providerSyncMode: "cut_off" },
    timeline: { duration: 2, videoDuration: 3.84, syncMode: "cut_off" }, usedRange: { start: 0, end: 2 },
    dialogues: [
      { dialogueId: "row-1", personId: "person-1", audioInputId: inputIds["person-1"][0], startTime: 0, duration: 1 },
      { dialogueId: "row-2", personId: "person-3", audioInputId: inputIds["person-3"][0], startTime: 0.25, duration: 1 },
      { dialogueId: "row-3", personId: "person-3", audioInputId: inputIds["person-3"][1], startTime: 1, duration: 1 },
    ],
    persons: [
      { personId: "person-1", detectionNumber: 1, anchor: { frameIndex: 12, pts: 0.48 }, anchorFaceBox: { x: 0.25, y: 0.2, width: 0.2, height: 0.3 } },
      { personId: "person-3", detectionNumber: 3, anchor: { frameIndex: 12, pts: 0.48 }, anchorFaceBox: { x: 0.625, y: 0.4, width: 0.125, height: 0.2 } },
    ].map((person) => ({ ...person, stepKeys: lipsyncPersonStepKeys(PLAN, person, CLIPS) })),
    tracking: { model: "sam3-video-rle" }, cropSize: 512, faceFeather: FROZEN_FACE_FEATHER,
    container: { containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
      prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
      limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, startSeconds: 3, encode: { crf: 18, preset: "medium" }, chunkRetries: 2,
      rawDiskBytes: FROZEN_RAW_DISK_BYTES },
    layout: LAYOUT, stageJobs: plannedStageJobs(LAYOUT),
    // Frozen like admission freezes them (DD §7.1 steps row; §97 D25-5).
    sharedStepKeys: lipsyncSharedStepKeys(PLAN, LAYOUT.composite.length, CLIPS),
    ...overrides,
  } as Fixture["execution"];
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${taskId},${target.userId},${target.projectId},${spaceId},'video','append','mini_tool','running','sync-lipsync-3',${pg.json({ miniToolExecution: execution } as never)},${pg.json({})})`;
  await presentationPinService.acquire({ holderKind: "execution", holderId: taskId, toolInputId: RECEIPT.toolInputId, objectKeys: presentationPinService.ledgerObjectKeys(SOURCE_KEY, RECEIPT.toolInputId) });
  const task = await taskRepo.getMiniToolExecutionTask(taskId);
  if (task === null) throw new Error("Fixture parent disappeared");
  return { execution, userId: target.userId, deadlineAt: await taskDeadline(task.id, task.createdAt), audioKeys };
}

/**
 * Drive pickups of the real runner until the one output ends.
 * @param f - The fixture.
 * @returns The output's result.
 * @throws {Error} When it never ends in thirty pickups.
 */
async function drive(f: Fixture): Promise<Record<string, unknown>> {
  const lipSync = await runner();
  for (let pickup = 0; pickup < 30; pickup += 1) {
    try {
      const answer = await lipSync(f.execution, f.userId, f.deadlineAt);
      const result = answer.results.get(0);
      if (result !== undefined) return result;
    } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  }
  throw new Error("The lip-sync run never ended");
}

/**
 * The first attempt of each submitted job of one recipe kind (a retried attempt carries the same step key).
 * @param kind - The recipe kind.
 * @returns The jobs.
 */
function jobsOf(kind: string): Job[] {
  const all = submitted.filter((job) => job.outputs[0]?.recipe.kind === kind);
  const seen = new Set<string>();
  return all.filter((job) => { const step = job.jobId.replace(/\d+$/, ""); if (seen.has(step)) return false; seen.add(step); return true; });
}

/**
 * The storage key a job binds an input id to.
 * @param job - The job.
 * @param inputId - The recipe's input id.
 * @returns The key.
 */
function bound(job: Job, inputId: unknown): string | undefined {
  return job.inputs.find((input) => input.inputId === inputId)?.storageKey;
}

/**
 * The run's live execution pin objects.
 * @param taskId - The run.
 * @returns Their keys.
 */
async function pinned(taskId: string): Promise<string[]> {
  const rows = await pg<{ storage_key: string }[]>`SELECT o.storage_key FROM presentation_pins p JOIN presentation_pin_objects o ON o.pin_id=p.id
    WHERE p.holder_kind='execution' AND p.holder_id=${taskId} AND p.deleted_at IS NULL`;
  return rows.map((row) => row.storage_key);
}

/**
 * How many canonical asset rows hold any of these keys.
 * @param keys - The keys.
 * @returns The count.
 */
async function assetsAt(keys: string[]): Promise<number> {
  const [row] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM studio_assets WHERE storage_key IN ${pg(keys)}`;
  return row!.n;
}

/**
 * A person's generate step of a provider model and the attempt id it submitted under.
 * @param f - The fixture.
 * @param endpoint - The provider model.
 * @param match - Picks the person's step by its stored request body.
 * @returns The attempt id.
 */
async function attemptOf(f: Fixture, endpoint: string, match: (body: Record<string, unknown>) => boolean): Promise<string> {
  const steps = (await upstreamStepRepo.listSteps(f.execution.taskId)).filter((step) => step.kind === "generate" && step.endpoint === endpoint);
  const found = steps.map((step) => miniToolStepStateSchema.parse(step.output.miniToolStep)).find((state) => match(state.requestBody as Record<string, unknown>));
  expect(found, `a ${endpoint} step for this person`).toBeDefined();
  return found!.attempts[0]!.attemptId;
}

/**
 * A person's derived RLE key of one tracking clip: that track step's key and its attempt's id.
 * @param f - The fixture.
 * @param person - The person.
 * @param direction - The clip.
 * @returns The key.
 */
async function rleKey(f: Fixture, person: Person, direction: "fwd" | "rev"): Promise<string> {
  const x = Number(Object.entries(BOX_X).find(([, who]) => who === person)![0]);
  const order = direction === "fwd" ? "forward" : "reverse";
  const attempt = await attemptOf(f, TRACKER, (body) => (body.box_prompts as { x_min: number }[])[0]!.x_min === x && directionOfClip(String(body.video)) === order);
  return stepObjectKey(lipsyncStepKey(PLAN, person, `track:${direction}`), attempt);
}

/**
 * A person's joined RLE: the output of its track_join job.
 * @param person - The person.
 * @returns The key.
 */
function joinedKey(person: Person): string {
  return personJob("rle_join", person).outputs[0]!.storageKey;
}

/**
 * The one first-attempt job of a kind for a person.
 * @param kind - The recipe kind.
 * @param person - The person.
 * @returns The job.
 */
function personJob(kind: string, person: Person): Job {
  const found = jobsOf(kind).filter((job) => personOfJob(job) === person);
  expect(found, `${kind} of ${person}`).toHaveLength(1);
  return found[0]!;
}

describe("lip-sync step bodies after track submits (§97 D21; execution design §9.1–§9.3; DD §7.2)", () => {
  it("LC00 prepares the shared forward and reversed clips once and tracks each on its frame 0 for every person (§10.2)", async () => {
    const f = await seed(); await drive(f);
    const shared = f.execution.sharedStepKeys as Record<string, string>;
    const clipJob = (order: string): Job => {
      const found = jobsOf("prepare_model_input").filter((job) => job.outputs[0]!.recipe.order === order);
      expect(found, `the ${order} clip`).toHaveLength(1);
      return found[0]!;
    };
    const [forward, reverse] = [clipJob("forward"), clipJob("reverse")];
    expect(forward.jobId).toContain(shared["prepare:fwd"]);
    expect(reverse.jobId).toContain(shared["prepare:rev"]);
    expect(forward.outputs[0]!.recipe.window).toEqual({ start: 12, end: 50 });
    expect(reverse.outputs[0]!.recipe.window).toEqual({ start: 0, end: 13 });
    const tracks = outside.runPrediction.mock.calls.filter((call) => call[1] === TRACKER).map((call) => call[2] as { video: string; box_prompts: { frame_index: number; x_min: number }[] });
    expect(tracks).toHaveLength(4);
    for (const person of PEOPLE) for (const job of [forward, reverse]) {
      const x = Number(Object.entries(BOX_X).find(([, who]) => who === person)![0]);
      const mine = tracks.filter((body) => body.video === publicUrl(job.outputs[0]!.storageKey) && body.box_prompts[0]!.x_min === x);
      expect(mine.map((body) => body.box_prompts[0]!.frame_index), `${person} on the ${String(job.outputs[0]!.recipe.order)} clip`).toEqual([0]);
    }
  });

  // Execution design §10.2: admission freezes the reversed clip's chunks from the reverse buffer it read, counted in the
  // stages and the quote; the worker sends exactly those chunks and their stitch, whatever today's buffer holds.
  it("LC00b prepares the reversed clip in exactly the chunks the plan froze, then stitches them latest first", async () => {
    const reverse = [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 13 }];
    const layout = { ...LAYOUT, tracking: { forward: LAYOUT.tracking.forward, reverse } };
    const f = await seed({ layout, stageJobs: plannedStageJobs(layout) }); await drive(f);
    const shared = f.execution.sharedStepKeys as Record<string, string>;
    const chunks = jobsOf("prepare_model_input").filter((job) => job.outputs[0]!.recipe.order === "reverse");
    expect(chunks.map((job) => job.outputs[0]!.recipe.window)).toEqual(reverse);
    for (const [k, job] of chunks.entries()) expect(job.jobId).toContain(`${shared["prepare:rev"]}.c${k}`);
    const stitch = jobsOf("stitch").filter((job) => job.jobId.includes(`${shared["prepare:rev"]}:`));
    expect(stitch).toHaveLength(1);
    expect(stitch[0]!.inputs.map((input) => input.storageKey).slice(1)).toEqual(chunks.map((job) => job.outputs[0]!.storageKey).reverse());
  });

  it("LC01 fetches each clip's SAM3 RLE link into ${track step key}:${attemptId}, pins it, and joins both for faces", async () => {
    const f = await seed(); await drive(f);
    for (const person of PEOPLE) {
      const keys = { fwd: await rleKey(f, person, "fwd"), rev: await rleKey(f, person, "rev") };
      for (const [direction, key] of Object.entries(keys)) {
        expect(outside.fetchUrl.mock.calls.map((call) => call[0])).toContain(`https://provider.example.test/rle/${person}-${direction === "fwd" ? "forward" : "reverse"}.json`);
        expect(await pinned(f.execution.taskId)).toContain(key);
        expect(await assetsAt([key])).toBe(0);
      }
      const join = personJob("rle_join", person);
      expect(join.jobId).toContain(f.execution.persons.find((p) => p.personId === person)!.stepKeys.track_join);
      const recipe = join.outputs[0]!.recipe as { inputs: { inputId: string; order: string; frameCount: number }[] };
      expect(recipe.inputs.map((input) => ({ key: bound(join, input.inputId), order: input.order, frameCount: input.frameCount })).sort((a, b) => a.order.localeCompare(b.order)))
        .toEqual([{ key: keys.fwd, order: "forward", frameCount: 38 }, { key: keys.rev, order: "reverse", frameCount: 13 }]);
      expect(join.outputs[0]).toMatchObject({ contentType: jsonType });
      expect(await pinned(f.execution.taskId)).toContain(joinedKey(person));
      // The faces step reads the joined object (§7.17 lipsync_faces row).
      const faces = personJob("lipsync_faces", person);
      expect(bound(faces, faces.outputs[0]!.recipe.track)).toBe(joinedKey(person));
    }
  });

  it("LC02 runs one lipsync_faces job per person on the prepared video and the person's RLE, keyed by its step key, output pinned", async () => {
    const f = await seed(); await drive(f);
    const preparedKey = submitted.find((job) => job.outputs[0]?.recipe.kind === "prepare_model_input" && job.outputs[0].recipe.order === undefined)?.outputs[0]?.storageKey;
    expect(preparedKey).toBeDefined();
    for (const person of PEOPLE) {
      const job = personJob("lipsync_faces", person);
      const recipe = job.outputs[0]!.recipe;
      expect(job.containerClass).toBe("MiniToolContainerStd4");
      expect(job.jobId).toContain(f.execution.persons.find((p) => p.personId === person)!.stepKeys.faces);
      expect(bound(job, recipe.inputId)).toBe(preparedKey);
      expect(recipe.profile).toMatchObject({ id: "opencv-yunet-2023mar" });
      expect(job.outputs[0]).toMatchObject({ storageKey: `${videoPresentationWorkKeyFor(SOURCE_KEY, job.jobId)}.txt`, contentType: jsonType });
      expect(await pinned(f.execution.taskId)).toContain(job.outputs[0]!.storageKey);
      expect(await assetsAt([job.outputs[0]!.storageKey])).toBe(0);
    }
  });

  it("LC03 runs each person's lipsync_clip over its faces table and RLE with the crop size and timeline, and lipsync_stem over its rows", async () => {
    const f = await seed(); await drive(f);
    for (const person of PEOPLE) {
      const faces = personJob("lipsync_faces", person);
      const clip = personJob("lipsync_clip", person);
      const stem = personJob("lipsync_stem", person);
      const keys = f.execution.persons.find((p) => p.personId === person)!.stepKeys;
      expect(clip.jobId).toContain(keys.clip);
      expect(stem.jobId).toContain(keys.stem);
      const c = clip.outputs[0]!.recipe;
      expect(bound(clip, c.faces)).toBe(faces.outputs[0]!.storageKey);
      expect(bound(clip, c.track)).toBe(joinedKey(person));
      // The clip streams its frames and carries no disk budget (execution design paragraph before §9.4).
      expect(c).toMatchObject({ cropSize: 512, timeline: { duration: 2, videoDuration: 3.84, syncMode: "cut_off" } });
      expect(c).not.toHaveProperty("rawBytes");
      // The clip is encoded at the plan's frozen container encode, as the composite's target is.
      expect(c).toMatchObject({ encode: (f.execution.container as { encode: unknown }).encode });
      expect(clip.outputs[0]).toMatchObject({ storageKey: `${videoPresentationWorkKeyFor(SOURCE_KEY, clip.jobId)}.mp4`, contentType: "video/mp4" });
      // Times are exact rationals, as every recipe carries them (§97 D20-1 lipsync_stem shape).
      const s = stem.outputs[0]!.recipe as { rows: { inputId: string; startTime: Exact }[]; duration: Exact };
      expect(seconds(s.duration)).toBe(2);
      expect(s.rows.map((row) => ({ key: bound(stem, row.inputId), startTime: seconds(row.startTime) })))
        .toEqual(person === "person-1" ? [{ key: f.audioKeys["person-1"][0], startTime: 0 }]
          : [{ key: f.audioKeys["person-3"][0], startTime: 0.25 }, { key: f.audioKeys["person-3"][1], startTime: 1 }]);
      expect(stem.outputs[0]!.storageKey).toBe(`${videoPresentationWorkKeyFor(SOURCE_KEY, stem.jobId)}.m4a`);
      const pins = await pinned(f.execution.taskId);
      expect(pins).toEqual(expect.arrayContaining([clip.outputs[0]!.storageKey, stem.outputs[0]!.storageKey]));
    }
  });

  it("LC04 submits each person's generation with exactly the person video and stem and sync_mode cut_off, and fetches its result into ${gen step key}:${attemptId}", async () => {
    const f = await seed(); await drive(f);
    const gens = outside.runPrediction.mock.calls.filter((call) => call[1] === GENERATOR);
    expect(gens).toHaveLength(2);
    for (const person of PEOPLE) {
      const clip = personJob("lipsync_clip", person).outputs[0]!.storageKey;
      const stem = personJob("lipsync_stem", person).outputs[0]!.storageKey;
      const body = { video: publicUrl(clip), audio: publicUrl(stem), sync_mode: "cut_off" };
      expect(gens.map((call) => call[2])).toContainEqual(body);
      // A model reads an object's type from its link's extension.
      expect(body.video).toMatch(/\.mp4$/);
      expect(body.audio).toMatch(/\.m4a$/);
      const attempt = await attemptOf(f, GENERATOR, (sent) => sent.video === body.video);
      const key = stepObjectKey(lipsyncStepKey(PLAN, person, "gen"), attempt);
      expect(outside.fetchUrl.mock.calls.map((call) => call[0])).toContain(`https://provider.example.test/gen/${person}.mp4`);
      expect(await pinned(f.execution.taskId)).toContain(key);
      expect(await assetsAt([key])).toBe(0);
    }
  });

  it("LC05 sends no sync_mode for a model frozen with a null provider sync mode", async () => {
    const f = await seed({ generator: { backend: "wavespeed-crop", modelId: "sync-lipsync-3", schemaFingerprint: "1".repeat(64), providerSyncMode: null } });
    await drive(f);
    const bodies = outside.runPrediction.mock.calls.filter((call) => call[1] === GENERATOR).map((call) => call[2] as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(Object.keys(body).sort()).toEqual(["audio", "video"]);
  });

  it("LC06 runs one lipsync_composite job per frozen composite chunk over every person's result, faces table and RLE, and never more jobs per stage than frozen", async () => {
    const f = await seed(); await drive(f);
    const composites = jobsOf("lipsync_composite");
    expect(composites).toHaveLength(LAYOUT.composite.length);
    const genKeys = await Promise.all(PEOPLE.map(async (person) => {
      const clip = personJob("lipsync_clip", person).outputs[0]!.storageKey;
      return stepObjectKey(lipsyncStepKey(PLAN, person, "gen"), await attemptOf(f, GENERATOR, (sent) => sent.video === publicUrl(clip)));
    }));
    for (const job of composites) {
      const recipe = job.outputs[0]!.recipe as { persons: { result: string; faces: string; track: string; cropSize: number }[]; timeline: unknown };
      expect(recipe.timeline).toEqual({ duration: 2, videoDuration: 3.84, syncMode: "cut_off" });
      expect(recipe.persons.map((p) => bound(job, p.result)).sort()).toEqual([...genKeys].sort());
      expect(recipe.persons.map((p) => p.cropSize)).toEqual([512, 512]);
      expect(job.outputs[0]!.storageKey).toBe(`${videoPresentationWorkKeyFor(SOURCE_KEY, job.jobId)}.mp4`);
      expect(await pinned(f.execution.taskId)).toContain(job.outputs[0]!.storageKey);
    }
    const frozen = new Map(plannedStageJobs(LAYOUT).map((stage) => [stage.stage, stage.jobs]));
    expect(jobsOf("lipsync_faces").length).toBeLessThanOrEqual(frozen.get("faces")!);
    expect(jobsOf("lipsync_clip").length + jobsOf("lipsync_stem").length).toBeLessThanOrEqual(frozen.get("clip_stem")!);
    expect(composites.length).toBeLessThanOrEqual(frozen.get("composite")!);
  });

  it("LC06c gives every composite chunk the raw disk budget the plan froze, not today's configured share (execution design paragraph before §9.4)", async () => {
    const f = await seed(); await drive(f);
    const composites = jobsOf("lipsync_composite");
    expect(composites.length).toBeGreaterThan(0);
    for (const job of composites) expect((job.outputs[0]!.recipe as { rawDiskBytes?: number }).rawDiskBytes).toBe(FROZEN_RAW_DISK_BYTES);
  });

  it("LC06d gives every composite chunk the face feather the plan froze, not today's configured one (DD §7.2 step 6)", async () => {
    const f = await seed(); await drive(f);
    const composites = jobsOf("lipsync_composite");
    expect(composites.length).toBeGreaterThan(0);
    expect(getMiniToolsConfig().executions["video.lip-sync"]?.face_feather).not.toBe(FROZEN_FACE_FEATHER);
    for (const job of composites) expect((job.outputs[0]!.recipe as { feather?: number }).feather).toBe(FROZEN_FACE_FEATHER);
  });

  it("LC06b decodes in each composite chunk only the source frames it shows (execution design paragraph before §9.4)", async () => {
    const f = await seed(); await drive(f);
    const composites = jobsOf("lipsync_composite");
    expect(composites).toHaveLength(LAYOUT.composite.length);
    for (const job of composites) {
      const recipe = job.outputs[0]!.recipe as { window: { start: number; end: number }; entries: { kind: string; displayStart?: Exact; displayEnd?: Exact }[] };
      const sources = recipe.entries.filter((entry) => entry.kind === "source");
      const seconds = (value: Exact): number => Number(value.numerator) / Number(value.denominator);
      // A 2 s cut_off timeline on the 25 fps source: result frame k shows source frame k, each 0.04 s long.
      expect(Math.min(...sources.map((entry) => seconds(entry.displayStart!)))).toBeCloseTo(recipe.window.start * 0.04, 9);
      expect(Math.max(...sources.map((entry) => seconds(entry.displayEnd!)))).toBeCloseTo(recipe.window.end * 0.04, 9);
    }
  });

  it("LC07 stitches the composite chunks with every stem in one job and registers the run's one output", async () => {
    const f = await seed(); const result = await drive(f);
    const stitches = jobsOf("stitch");
    expect(stitches).toHaveLength(1);
    const keys = stitches[0]!.inputs.map((input) => input.storageKey);
    expect(keys).toEqual(expect.arrayContaining([...jobsOf("lipsync_composite").map((job) => job.outputs[0]!.storageKey), ...PEOPLE.map((person) => personJob("lipsync_stem", person).outputs[0]!.storageKey)]));
    // §97 D22-3: the final audio is every person's stem summed (execution §9.2 last paragraph).
    const audio = stitches[0]!.outputs[0]!.recipe.audio as { kind: string; inputs: string[] };
    expect(audio.kind).toBe("mix");
    expect(audio.inputs.map((inputId) => bound(stitches[0]!, inputId)).sort())
      .toEqual(PEOPLE.map((person) => personJob("lipsync_stem", person).outputs[0]!.storageKey).sort());
    expect(result).toMatchObject({ status: "registered", kind: "video" });
  });

  it.each([
    ["a 400 on submit", (): unknown => new HttpStatusError("wavespeed", 400, "bad input")],
    ["a 422 on submit", (): unknown => new HttpStatusError("wavespeed", 422, "unprocessable")],
    ["the model's configured asynchronous rejection", (): unknown => new UpstreamTaskFailed("wavespeed", "rejected", { error: { code: "lipsync_input_rejected" } })],
  ])("LC08 %s of a person's generation is model_rejected in the one reason", async (_name, fault) => {
    const f = await seed(); genFault["person-1"] = fault();
    const result = await drive(f) as { status: string; error: { persons: unknown[] } };
    expect(result.status).toBe("failed");
    expect(lipsyncFailureReasonSchema.safeParse(result.error).success).toBe(true);
    expect(result.error.persons).toContainEqual({ personId: "person-1", detectionNumber: 1, step: "gen", category: "model_rejected" });
  });

  it("LC09 an asynchronous failure without the configured field is failed, not model_rejected", async () => {
    const f = await seed(); genFault["person-1"] = new UpstreamTaskFailed("wavespeed", "rejected", { error: { code: "something_else" } });
    const result = await drive(f) as { error: { persons: unknown[] } };
    expect(result.error.persons).toContainEqual({ personId: "person-1", detectionNumber: 1, step: "gen", category: "failed" });
  });
});

/**
 * Serve a variant of the fixture's full ledger and return the receipt that measures it (the reader checks the bytes'
 * size and SHA-256 against the receipt, and the plan's identities against it, never the plan against its hash).
 * @param change - Edits the parsed ledger in place.
 * @returns The receipt.
 */
function serveLedger(change: (ledger: { plan: { policy: { emptyFill: string }; display: { width: number; height: number } } }) => void): typeof RECEIPT {
  const ledger = JSON.parse(LEDGER.toString("utf8")) as Parameters<typeof change>[0];
  change(ledger);
  ledgerBytes = Buffer.from(JSON.stringify(ledger));
  return { ...RECEIPT, size: ledgerBytes.byteLength, sha256: createHash("sha256").update(ledgerBytes).digest("hex") };
}

// Frames-split §7.17 lipsync_composite row and §4.3 odd-size row: a transparent original's composite chunks are VP9 WebM
// with straight alpha, as its stitch is, so every chunk request the worker builds is one the job schema admits.
describe("a transparent original's lip-sync composite (§7.17 lipsync_composite row; §4.3)", () => {
  it("LC10 builds every composite chunk as a webm-vp9 target declared video/webm, and the run registers", async () => {
    const receipt = serveLedger((ledger) => { ledger.plan.policy.emptyFill = "transparent"; });
    const f = await seed({ ledgerReceipts: { source: receipt } });
    const result = await drive(f);
    const composites = jobsOf("lipsync_composite");
    expect(composites).toHaveLength(LAYOUT.composite.length);
    for (const job of composites) {
      expect(miniToolPlanJobRequestSchema.safeParse(job).success, "the job schema admits the chunk").toBe(true);
      const output = job.outputs[0]!;
      expect({ format: (output.recipe.target as { format?: string }).format, alpha: (output.recipe.target as { alpha?: string }).alpha, contentType: output.contentType })
        .toEqual({ format: "webm-vp9", alpha: "straight", contentType: "video/webm" });
      expect(output.storageKey).toBe(`${videoPresentationWorkKeyFor(SOURCE_KEY, job.jobId)}.webm`);
    }
    expect(result).toMatchObject({ status: "registered", kind: "video" });
  });
});

// §5.3 model-input row, §4.3 odd-size row: an odd display is prepared padded to even with its picture rectangle kept, and
// the tracks and face tables are in those pixels, so every composite chunk names that geometry; the output picture rounds
// the opaque odd side down.
describe("an odd-size original's lip-sync composite names the prepared geometry (§5.3; §4.3)", () => {
  it("LC11 gives every composite chunk the prepared video's size and picture rectangle beside the output target", async () => {
    const receipt = serveLedger((ledger) => { ledger.plan.display = { ...ledger.plan.display, width: 319, height: 179 }; });
    const f = await seed({ ledgerReceipts: { source: receipt } });
    await drive(f);
    const prepared = jobsOf("prepare_model_input").find((job) => job.outputs[0]!.recipe.order === undefined)!.outputs[0]!.recipe.target as { width: number; height: number; displayRect: unknown };
    expect(prepared).toMatchObject({ width: 320, height: 180, displayRect: { x: 0, y: 0, width: 319, height: 179 } });
    const composites = jobsOf("lipsync_composite");
    expect(composites).toHaveLength(LAYOUT.composite.length);
    for (const job of composites) {
      const recipe = job.outputs[0]!.recipe as { prepared: unknown; target: { width: number; height: number } };
      expect(recipe.prepared).toEqual({ width: prepared.width, height: prepared.height, displayRect: prepared.displayRect });
      expect([recipe.target.width, recipe.target.height]).toEqual([318, 178]);
    }
  });
});

describe("a lip-sync retry reuses the done steps by their frozen keys (§97 D21-6; DD §7.1; frames-split §7.11 retry row)", () => {
  it("LR10 after person 3's generation timed out, the retry submits only that generation; person 1 adds no consumption", async () => {
    const original = await seed();
    genFault["person-3"] = new HttpStatusError("wavespeed", 503, "busy");
    const first = await drive(original) as { status: string; error: unknown };
    expect(first).toMatchObject({ status: "failed", error: { persons: [{ personId: "person-3", step: "gen", category: "timeout" }] } });
    const person1Video = publicUrl(personJob("lipsync_clip", "person-1").outputs[0]!.storageKey);
    const person3Video = publicUrl(personJob("lipsync_clip", "person-3").outputs[0]!.storageKey);
    genFault = {};
    outside.runPrediction.mockClear(); submitted = [];
    const retry = await seed({ retry: { runId: original.execution.taskId, outputIndexes: [0] }, planFingerprint: "f".repeat(64) });
    // Same frozen plan: the step keys stay those of the original plan.
    retry.execution.persons = structuredClone(original.execution.persons);
      retry.execution.sharedStepKeys = structuredClone(original.execution.sharedStepKeys);
    retry.execution.dialogues = structuredClone(original.execution.dialogues);
    retry.execution.draft = structuredClone(original.execution.draft);
    expect(await drive(retry)).toMatchObject({ status: "registered" });
    expect(outside.runPrediction.mock.calls.map((call) => [call[1], (call[2] as { video?: string }).video])).toEqual([[GENERATOR, person3Video]]);
    expect(submitted.filter((job) => ["prepare_model_input", "lipsync_faces", "lipsync_clip", "lipsync_stem"].includes(String(job.outputs[0]?.recipe.kind)))).toEqual([]);
    const steps = await upstreamStepRepo.listSteps(retry.execution.taskId);
    // Person 1's own steps: a generate step whose body is person 1's (its track box or its person video), or a container
    // step whose own job id carries one of person 1's step keys. Composite and stitch jobs read person 1's objects as inputs
    // and are shared steps, so they are not counted here.
    const person1Keys = Object.values(original.execution.persons.find((person) => person.personId === "person-1")!.stepKeys);
    const person1Steps = steps.filter((step) => {
      const body = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep).requestBody as { video?: string; box_prompts?: { x_min: number }[] } | null;
      const jobId = (step.output.miniToolPlanJob as { jobId?: string } | undefined)?.jobId ?? "";
      return body?.video === person1Video || body?.box_prompts?.[0]?.x_min === 80 || person1Keys.some((key) => jobId.includes(key));
    });
    expect(person1Steps.filter((step) => step.output.miniToolConsumption !== undefined)).toEqual([]);
  });

  it("LR11 a retry of a retry reuses every step done anywhere along the chain: the original's and the first retry's", async () => {
    // The original: person 3's generation times out.
    const original = await seed();
    genFault["person-3"] = new HttpStatusError("wavespeed", 503, "busy");
    expect(await drive(original)).toMatchObject({ status: "failed" });
    /**
     * A retry of a run on the same frozen plan (its own task id and fingerprint, the original's persons and rows).
     * @param runId - The run it retries.
     * @param fingerprint - Its own plan fingerprint.
     * @returns The retry.
     */
    const retryOf = async (runId: string, fingerprint: string): Promise<Fixture> => {
      const retry = await seed({ retry: { runId, outputIndexes: [0] }, planFingerprint: fingerprint });
      retry.execution.persons = structuredClone(original.execution.persons);
      retry.execution.sharedStepKeys = structuredClone(original.execution.sharedStepKeys);
      retry.execution.dialogues = structuredClone(original.execution.dialogues);
      retry.execution.draft = structuredClone(original.execution.draft);
      return retry;
    };
    // The first retry: person 3's generation now succeeds, but the second composite chunk fails on every attempt.
    genFault = {}; outside.runPrediction.mockClear();
    const first = await retryOf(original.execution.taskId, "e".repeat(64));
    failJob = (job) => job.jobId.startsWith(first.execution.taskId) && job.outputs[0]?.recipe.kind === "lipsync_composite"
      && (job.outputs[0].recipe.window as { start: number }).start === LAYOUT.composite[1]!.start;
    expect(await drive(first)).toMatchObject({ status: "failed", error: { persons: [], shared: { step: "composite" } } });
    expect(outside.runPrediction.mock.calls.filter((call) => call[1] === GENERATOR)).toHaveLength(1);
    // The second retry, of the first: everything but the failed chunk and the stitch is done somewhere along the chain.
    failJob = () => false;
    outside.runPrediction.mockClear(); submitted = [];
    const second = await retryOf(first.execution.taskId, "c".repeat(64));
    expect(await drive(second)).toMatchObject({ status: "registered" });
    expect(outside.runPrediction).not.toHaveBeenCalled();
    expect(submitted.filter((job) => ["prepare_model_input", "lipsync_faces", "lipsync_clip", "lipsync_stem"].includes(String(job.outputs[0]?.recipe.kind)))).toEqual([]);
    // The first composite chunk was done in the first retry: only the second is run again.
    expect(jobsOf("lipsync_composite").map((job) => job.outputs[0]!.recipe.window)).toEqual([LAYOUT.composite[1]]);
    expect(jobsOf("stitch")).toHaveLength(1);
    const steps = await upstreamStepRepo.listSteps(second.execution.taskId);
    expect(steps.filter((step) => step.kind === "generate")).toEqual([]);
  });
});

// Frames-split §5.4 parallel stage: the composite chunks advance together, and the composite settles only once none still runs,
// so a running chunk's object is recorded and pinned with the run; after a chunk failed for good no chunk opens a next attempt.
describe("the lip-sync composite chunks settle together (frames-split §5.4; DD §7.2 step 6)", () => {
  it("LC12 a composite chunk failed for good waits for a running chunk, whose object is pinned, and no chunk opens a next attempt after it", async () => {
    const layout = { ...LAYOUT, composite: [{ start: 0, end: 17 }, { start: 17, end: 34 }, { start: 34, end: 50 }] };
    const f = await seed({ layout, stageJobs: plannedStageJobs(layout), sharedStepKeys: lipsyncSharedStepKeys(PLAN, layout.composite.length, CLIPS) });
    const shared = f.execution.sharedStepKeys as Record<string, string>;
    /**
     * A composite chunk attempt's job id.
     * @param k - The chunk.
     * @param attempt - The attempt.
     * @returns The id.
     */
    const job = (k: number, attempt: number): string => `${f.execution.taskId}:${shared[`composite:${k}`]}:a${attempt}`;
    for (const k of [0, 1, 2]) scripted.set(job(k, 1), { schemaVersion: 2, state: "running" });
    const lipSync = await runner();
    /**
     * One pickup of the real runner.
     * @returns The output's result once it ended.
     */
    const pickup = async (): Promise<Record<string, unknown> | undefined> => {
      try { return (await lipSync(f.execution, f.userId, f.deadlineAt)).results.get(0); } catch (error) {
        if (!(error instanceof StillRunning)) throw error;
        return undefined;
      }
    };
    for (let at = 0; at < 30 && ![0, 1, 2].every((k) => submitted.some((sent) => sent.jobId === job(k, 1))); at += 1) expect(await pickup()).toBeUndefined();
    // Chunk 0 fails on every attempt and chunk 2's first attempt fails while chunk 1 still runs: the run does not end.
    scripted.delete(job(0, 1)); scripted.set(job(2, 1), failedReport());
    failJob = (request) => request.jobId.startsWith(`${f.execution.taskId}:${shared["composite:0"]}:`);
    expect(await pickup()).toBeUndefined();
    scripted.delete(job(1, 1));
    expect(await pickup()).toMatchObject({ status: "failed", error: { shared: { step: "composite" } } });
    expect(submitted.map((sent) => sent.jobId)).not.toContain(job(2, 2));
    expect(await pinned(f.execution.taskId)).toContain(submitted.find((sent) => sent.jobId === job(1, 1))!.outputs[0]!.storageKey);
  });
});

// Worker AGENTS.md "Upstream field names are mapped in one place": the track and gen bodies are built by
// `providers/upstream-body.ts` from each param's `upstream` in the model yaml, so renaming a declared field in the catalog
// renames the submitted key (§97 D25-8). `sync_mode` is declared on `sync-lipsync-3`.
describe("lip-sync request bodies follow the model yaml's upstream names (§97 D25-8)", () => {
  it("LU01 renaming SAM3's and sync-3's declared upstream fields renames the submitted keys", async () => {
    outside.rename = true;
    const f = await seed(); await drive(f);
    const track = outside.runPrediction.mock.calls.find((call) => call[1] === TRACKER)![2] as Record<string, unknown>;
    expect(Object.keys(track).sort()).toEqual(["boxes", "mask_preview", "prompt", "source_video"]);
    expect(track.mask_preview).toBe(false);
    expect((track.boxes as Record<string, unknown>[])[0]).toMatchObject({ frame_index: 0, object_id: 1 });
    const gen = outside.runPrediction.mock.calls.find((call) => call[1] === GENERATOR)![2] as Record<string, unknown>;
    expect(Object.keys(gen).sort()).toEqual(["input_audio", "input_video", "mode"]);
    expect(gen.mode).toBe("cut_off");
  });

  it("LU02 the catalog declares sync_mode on sync-lipsync-3", async () => {
    const actual = await vi.importActual<typeof domainModule>("@breatic/domain");
    const model = actual.getFullModelConfig("video").models.find((candidate) => candidate.name === "sync-lipsync-3");
    expect(model?.params?.sync_mode, "sync-lipsync-3 declares sync_mode").toBeDefined();
  });
});

// Execution design §9.4: a container step whose next attempt is due after the run's deadline is never opened, and the run
// ends with the expiry line, as a run whose budget ended does (run-execution-task's DeadlinePassed reason).
describe("a lip-sync step whose next attempt is due after the deadline ends the run with the expiry line (execution design §9.4)", () => {
  /**
   * Drive the real runner with the first job of a recipe kind running until the deadline passes, when ingest expires it
   * (a failed report with reason expired, transition.ts); every pickup from then on runs past the deadline.
   * @param kind - The recipe kind.
   * @returns The output's result.
   * @throws {Error} When a step throws or the run never ends.
   */
  async function expireAtDeadline(kind: string): Promise<Record<string, unknown>> {
    const f = await seed();
    let held: string | null = null;
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const job = init?.method === "POST" && String(input).endsWith("/jobs") ? JSON.parse(String(init.body)) as Job : null;
      if (held === null && job?.outputs[0]?.recipe.kind === kind) { held = job.jobId; scripted.set(held, { schemaVersion: 2, state: "running" }); }
      return original(input, init);
    });
    const lipSync = await runner();
    let deadlineAt = f.deadlineAt;
    for (let pickup = 0; pickup < 30; pickup += 1) {
      if (held !== null && deadlineAt === f.deadlineAt) { scripted.set(held, { ...failedReport(), reason: "expired" }); deadlineAt = Date.now() - 1; }
      try {
        const result = (await lipSync(f.execution, f.userId, deadlineAt)).results.get(0);
        if (result !== undefined) return result;
      } catch (error) { if (!(error instanceof StillRunning)) throw error; }
    }
    throw new Error("The lip-sync run never ended");
  }

  it.each([
    ["LX01 a person's faces job", "lipsync_faces"],
    ["LX02 a composite chunk", "lipsync_composite"],
    ["LX03 the stitch", "stitch"],
  ])("%s expired at the deadline ends as the expiry line", async (_name, kind) => {
    expect(await expireAtDeadline(kind)).toEqual({ status: "failed", error: { kind: "lipsync", persons: [], shared: { step: "expired", category: "timeout" } } });
  });

  it("LX05 a person's generate step due after the deadline ends as the expiry line and appends no generate step", async () => {
    const f = await seed();
    let held: string | null = null;
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const job = init?.method === "POST" && String(input).endsWith("/jobs") ? JSON.parse(String(init.body)) as Job : null;
      if (held === null && job?.outputs[0]?.recipe.kind === "lipsync_stem") { held = job.jobId; scripted.set(held, { schemaVersion: 2, state: "running" }); }
      return original(input, init);
    });
    const lipSync = await runner();
    let deadlineAt = f.deadlineAt;
    let result: Record<string, unknown> | undefined;
    for (let pickup = 0; pickup < 30 && result === undefined; pickup += 1) {
      // The stem reports done once the deadline has passed, so the generate step after it is due after the deadline.
      if (held !== null && deadlineAt === f.deadlineAt) { scripted.delete(held); deadlineAt = Date.now() - 1; }
      try { result = (await lipSync(f.execution, f.userId, deadlineAt)).results.get(0); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
    }
    expect((await upstreamStepRepo.listSteps(f.execution.taskId)).map((step) => step.endpoint)).not.toContain(GENERATOR);
    expect(result).toEqual({ status: "failed", error: { kind: "lipsync", persons: [], shared: { step: "expired", category: "timeout" } } });
  });

  it("LX04 the preparation expired at the deadline ends the run as expired, which the entry commits as the expiry line", async () => {
    await expect(expireAtDeadline("prepare_model_input")).rejects.toBeInstanceOf(DeadlinePassed);
  });
});
