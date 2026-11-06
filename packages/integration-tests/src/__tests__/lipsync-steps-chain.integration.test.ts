// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * - track: SAM3's `rle_url` is fetched into the derived key `${stepKeys.track}:${attemptId}` (the step's
 *   `MiniToolStepAttempt.attemptId`), pinned on the run's execution pin, with no `studio_assets` row (D21-1).
 * - faces, clip, stem, composite: standard-4 container jobs with the §7.17 recipes (shapes of §97 D20-1), their job ids
 *   built from the step key and an attempt ordinal and their outputs at `videoPresentationWorkKeyFor(sourceKey, jobId)`
 *   (D21-2), each output pinned and not registered; per stage no more first-attempt jobs than the frozen `stageJobs`.
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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import type * as coreModule from "@breatic/core";
import { miniToolStepStateSchema, presentationPinService, taskRepo, upstreamStepRepo } from "@breatic/domain";
import type * as sharedModule from "@breatic/shared";
import { videoPresentationWorkKeyFor } from "@breatic/shared";
import { lipsyncFailureReasonSchema, plannedStageJobs } from "@breatic/shared/mini-tools";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { lipsyncObjectKey, lipsyncStepKey } from "@worker/handlers/mini-tool/lipsync-steps.js";
import { seedStudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { INGEST_ENV } from "./ingest-jobs-fake.js";

const outside = vi.hoisted(() => ({ runPrediction: vi.fn(), fetchUrl: vi.fn(), config: { rejection: { path: "error.code", equals: "lipsync_input_rejected" } } }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction: outside.runPrediction }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(), fetchUrlToIngest: outside.fetchUrl }));
// Today's configuration offers lip-sync with sync-3 and the asynchronous rejection field its measurement found (§9.3).
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => {
    const config = structuredClone(actual.getMiniToolsConfig());
    Reflect.set(config.executions, "video.lip-sync", { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1, max_outputs_per_job: 1,
      models: [{ name: "sync-lipsync-3", schema_fingerprint: "1".repeat(64), min_duration_seconds: 1, max_duration_seconds: 300, crop_size: 512, accepts_sync_mode: true,
        async_rejection: outside.config.rejection }],
      tracking: { model: "sam3-video-rle", min_duration_seconds: 1, max_duration_seconds: 600 }, max_people: 2, max_dialogues: 8 });
    return config;
  } };
});

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
const LAYOUT = { preparation: [{ start: 0, end: 50 }], persons: 2, composite: [{ start: 0, end: 25 }, { start: 25, end: 50 }] };

interface Job { jobId: string; containerClass: string; inputs: { inputId: string; storageKey: string }[]; outputs: { outputIndex: number; storageKey: string; contentType: string; recipe: Record<string, unknown> }[] }
interface Fixture { execution: Record<string, unknown> & { taskId: string; persons: { personId: Person; stepKeys: Record<string, string> }[] }; userId: string; deadlineAt: number; audioKeys: Record<Person, string[]> }

let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;
let submitted: Job[];
let scripted: Map<string, Record<string, unknown>>;
// Per-person provider behaviour of the generation submit.
let genFault: Partial<Record<Person, unknown>>;

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
  return { schemaVersion: 2, state: "done", usage: { wallMs: 1000, cpuUsec: 2000000 }, outputs: request.outputs.map((output) => ({
    outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType,
    ...(output.contentType.startsWith("video/") ? { width: 320, height: 180, durationSeconds: 2, cover: null, upright: null } : {}) })) };
}

beforeAll(async () => {
  configure(); loadLocales(); pg = createPgClient(inject("DATABASE_URL"), { name: "lipsync-chain", max: 6 });
  const storage = await getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => {
  vi.clearAllMocks(); configure();
  submitted = []; scripted = new Map(); genFault = {};
  outside.config.rejection = { path: "error.code", equals: "lipsync_input_rejected" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Job; submitted.push(request);
      return Response.json(scripted.get(request.jobId) ?? done(request));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = submitted.find((candidate) => candidate.jobId === id);
      return request === undefined ? new Response("missing", { status: 404 }) : Response.json(scripted.get(id) ?? done(request));
    }
    if (url.pathname.includes(".video-source-ledger.")) return new Response(LEDGER, { headers: { "content-type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }));
  outside.runPrediction.mockImplementation(async (_connection: unknown, model: string, body: Record<string, unknown>, resume: { storedTaskId: string | null; persistTaskId: (id: string) => Promise<void> }) => {
    const id = resume.storedTaskId ?? randomUUID();
    if (model === TRACKER) {
      const person = BOX_X[((body.box_prompts as { x_min: number }[])[0]!).x_min]!;
      if (resume.storedTaskId === null) await resume.persistTaskId(id);
      return { taskId: id, outputs: [{ rle_url: `https://provider.example.test/rle/${person}.json`, video_url: `https://provider.example.test/preview/${person}.mp4` }] };
    }
    const person = personOfClip(String(body.video));
    if (person !== null && genFault[person] !== undefined) throw genFault[person];
    if (resume.storedTaskId === null) await resume.persistTaskId(id);
    return { taskId: id, outputs: [`https://provider.example.test/gen/${person ?? "unknown"}.mp4`] };
  });
  outside.fetchUrl.mockImplementation(async (sourceUrl: string) => ({
    sha256: "8".repeat(64), sizeBytes: 4096, contentType: sourceUrl.endsWith(".json") ? "application/json" : "video/mp4" }));
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
 * The person a per-person container job belongs to, by the person's frozen step keys in its job id.
 * @param job - The job.
 * @returns The person, or null for a shared job.
 */
function personOfJob(job: Job): Person | null {
  for (const person of PEOPLE) for (const kind of ["faces", "clip", "stem"]) if (job.jobId.includes(lipsyncStepKey(PLAN, person, kind as "faces"))) return person;
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
    ].map((person) => ({ ...person, stepKeys: Object.fromEntries((["track", "faces", "clip", "stem", "gen"] as const).map((kind) => [kind, lipsyncStepKey(PLAN, person.personId, kind)])) })),
    tracking: { model: "sam3-video-rle" }, cropSize: 512,
    container: { containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
      prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
      limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, startSeconds: 3, encode: { crf: 18, preset: "medium" }, chunkRetries: 2 },
    layout: LAYOUT, stageJobs: plannedStageJobs(LAYOUT),
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
 * A person's derived RLE key: the track step key and the track attempt's id.
 * @param f - The fixture.
 * @param person - The person.
 * @returns The key.
 */
async function rleKey(f: Fixture, person: Person): Promise<string> {
  const x = Number(Object.entries(BOX_X).find(([, who]) => who === person)![0]);
  const attempt = await attemptOf(f, TRACKER, (body) => (body.box_prompts as { x_min: number }[])[0]!.x_min === x);
  return lipsyncObjectKey(lipsyncStepKey(PLAN, person, "track"), attempt);
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
  it("LC01 fetches each person's SAM3 RLE link into ${track step key}:${attemptId}, pins it and registers no asset", async () => {
    const f = await seed(); await drive(f);
    for (const person of PEOPLE) {
      const key = await rleKey(f, person);
      expect(outside.fetchUrl.mock.calls.map((call) => call[0])).toContain(`https://provider.example.test/rle/${person}.json`);
      expect(await pinned(f.execution.taskId)).toContain(key);
      expect(await assetsAt([key])).toBe(0);
      // The faces step reads that object (§7.17 lipsync_faces row).
      const faces = personJob("lipsync_faces", person);
      expect(bound(faces, faces.outputs[0]!.recipe.track)).toBe(key);
    }
  });

  it("LC02 runs one lipsync_faces job per person on the prepared video and the person's RLE, keyed by its step key, output pinned", async () => {
    const f = await seed(); await drive(f);
    const preparedKey = submitted.find((job) => job.outputs[0]?.recipe.kind === "prepare_model_input")?.outputs[0]?.storageKey;
    expect(preparedKey).toBeDefined();
    for (const person of PEOPLE) {
      const job = personJob("lipsync_faces", person);
      const recipe = job.outputs[0]!.recipe;
      expect(job.containerClass).toBe("MiniToolContainerStd4");
      expect(job.jobId).toContain(f.execution.persons.find((p) => p.personId === person)!.stepKeys.faces);
      expect(bound(job, recipe.inputId)).toBe(preparedKey);
      expect(recipe.profile).toMatchObject({ id: "opencv-yunet-2023mar" });
      expect(job.outputs[0]).toMatchObject({ storageKey: videoPresentationWorkKeyFor(SOURCE_KEY, job.jobId), contentType: "application/json" });
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
      expect(bound(clip, c.track)).toBe(await rleKey(f, person));
      expect(c).toMatchObject({ cropSize: 512, timeline: { duration: 2, videoDuration: 3.84, syncMode: "cut_off" } });
      expect(clip.outputs[0]).toMatchObject({ storageKey: videoPresentationWorkKeyFor(SOURCE_KEY, clip.jobId), contentType: "video/mp4" });
      const s = stem.outputs[0]!.recipe as { rows: { inputId: string; startTime: number }[]; duration: number };
      expect(s.duration).toBe(2);
      expect(s.rows.map((row) => ({ key: bound(stem, row.inputId), startTime: row.startTime })))
        .toEqual(person === "person-1" ? [{ key: f.audioKeys["person-1"][0], startTime: 0 }]
          : [{ key: f.audioKeys["person-3"][0], startTime: 0.25 }, { key: f.audioKeys["person-3"][1], startTime: 1 }]);
      expect(stem.outputs[0]!.storageKey).toBe(videoPresentationWorkKeyFor(SOURCE_KEY, stem.jobId));
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
      const attempt = await attemptOf(f, GENERATOR, (sent) => sent.video === body.video);
      const key = lipsyncObjectKey(lipsyncStepKey(PLAN, person, "gen"), attempt);
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
      return lipsyncObjectKey(lipsyncStepKey(PLAN, person, "gen"), await attemptOf(f, GENERATOR, (sent) => sent.video === publicUrl(clip)));
    }));
    for (const job of composites) {
      const recipe = job.outputs[0]!.recipe as { persons: { result: string; faces: string; track: string; cropSize: number }[]; timeline: unknown };
      expect(recipe.timeline).toEqual({ duration: 2, videoDuration: 3.84, syncMode: "cut_off" });
      expect(recipe.persons.map((p) => bound(job, p.result)).sort()).toEqual([...genKeys].sort());
      expect(recipe.persons.map((p) => p.cropSize)).toEqual([512, 512]);
      expect(job.outputs[0]!.storageKey).toBe(videoPresentationWorkKeyFor(SOURCE_KEY, job.jobId));
      expect(await pinned(f.execution.taskId)).toContain(job.outputs[0]!.storageKey);
    }
    const frozen = new Map(plannedStageJobs(LAYOUT).map((stage) => [stage.stage, stage.jobs]));
    expect(jobsOf("lipsync_faces").length).toBeLessThanOrEqual(frozen.get("faces")!);
    expect(jobsOf("lipsync_clip").length + jobsOf("lipsync_stem").length).toBeLessThanOrEqual(frozen.get("clip_stem")!);
    expect(composites.length).toBeLessThanOrEqual(frozen.get("composite")!);
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
    retry.execution.dialogues = structuredClone(original.execution.dialogues);
    retry.execution.draft = structuredClone(original.execution.draft);
    expect(await drive(retry)).toMatchObject({ status: "registered" });
    expect(outside.runPrediction.mock.calls.map((call) => [call[1], (call[2] as { video?: string }).video])).toEqual([[GENERATOR, person3Video]]);
    expect(submitted.filter((job) => ["prepare_model_input", "lipsync_faces", "lipsync_clip", "lipsync_stem"].includes(String(job.outputs[0]?.recipe.kind)))).toEqual([]);
    const steps = await upstreamStepRepo.listSteps(retry.execution.taskId);
    const person1Steps = steps.filter((step) => {
      const body = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep).requestBody as { video?: string } | null;
      return body?.video === person1Video || PEOPLE.slice(0, 1).some((person) => ["track", "faces", "clip", "stem", "gen"]
        .some((kind) => JSON.stringify(step.output.miniToolPlanJob ?? "").includes(lipsyncStepKey(PLAN, person, kind as "faces"))));
    });
    expect(person1Steps.filter((step) => step.output.miniToolConsumption !== undefined)).toEqual([]);
  });
});
