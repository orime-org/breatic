// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lip-sync execution admission (inner#1306 test plan §97; frames-split design §7.11 fresh row and §5.4 上限 row; execution
 * design §9.2, §9.3 with its pricing paragraph, §9.4; multi-person lip-sync DD §7.1 frozen plan table).
 *
 * Real admission, authorization, PG, Redis, holds and queue; only the external presentation snapshot (ingest) and the
 * the stored objects (fetch) are controlled, as in planned-video-admission. A fresh lip-sync run is admitted only when
 * its `draft.params.modelId` is a configured selectable model, the planned `timeline.duration` lies in that model's
 * duration range, the used source range (shared `lipsyncUsedSourceRange`) lies in the tracking model's range, and the
 * referenced people and dialogue rows stay within `max_people` and `max_dialogues`; each refusal is a 400 the user can
 * read (not a stale-page `request_shape`) with no durable effect. The frozen plan carries `generator` and `timeline`
 * (from server-measured audio durations), and the quote is per-person generation plus per-person tracking plus the
 * standard-4 container work.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Queue } from "bullmq";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import * as shared from "@breatic/shared";
import * as miniTools from "@breatic/shared/mini-tools";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord } from "@breatic/shared/mini-tools";
import {
  containerCostUsd, creditHoldService, creditsForUsd, estimateTaskCredits, miniToolExecutionService, miniToolFrozenAnalysisSchema,
  MIN_TASK_CREDIT_COST, presentationPinService,
} from "@breatic/domain";
// The worker's §7.15 write point for derived step objects; the domain entry does not export the repository.
import { appendPinObjects } from "@domain/presentation/presentation-pin.repo.js";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { presentedSource, type PresentedSource } from "./presentation-fixtures.js";

type SyncMode = "cut_off" | "silence" | "loop" | "bounce" | "remap";
interface LipSyncModel { name: string; schema_fingerprint: string; min_duration_seconds: number; max_duration_seconds: number; crop_size: number; accepts_sync_mode: boolean }
interface LipSyncExecution {
  container_class: string; precheck_seconds: number; max_outputs: number; max_outputs_per_job: number; models: LipSyncModel[];
  tracking: { model: string; min_duration_seconds: number; max_duration_seconds: number }; max_people: number; max_dialogues: number; face_feather: number;
}
interface Row { dialogueId: string; personId: string; analysisRunId: string; audioInputId: string; startTime: number }
interface Body {
  tool: "video.lip-sync"; project_id: string; space_id: string; run_id: string;
  draft: {
    version: 1; draftId: string; revision: string;
    source: { nodeId: string; canonicalURL: string; mediaInfo: { width: number; height: number; duration: number; mimeType: string } };
    inputs: { inputId: string; url: string; mediaInfo: { duration: number; mimeType: string } }[];
    params: { anchor: { frameIndex: number }; dialogues: Row[]; syncMode: SyncMode; modelId: string };
  };
  analysis_refs: { version: 1; draftId: string; analysisRunId: string; inputFingerprint: string; toolId: "video.lip-sync"; kind: "people" }[];
  presentation_ref: PresentedSource["presentationRef"];
  outputs: { outputIndex: number; nodeId: string; recipe: { kind: "lip-sync" } }[];
}
interface Audio { inputId: string; assetId: string; url: string; duration: number }
interface Fixture extends StudioFixture { body: Body; people: string[]; audios: Audio[]; analysisRunId: string }
interface Timeline { duration: number; videoDuration: number; syncMode: SyncMode }
interface Plan extends Record<string, unknown> {
  tool: string; credits: number; timeline: Timeline;
  generator: { backend: string; modelId: string; schemaFingerprint: string; providerSyncMode: "cut_off" | null };
  persons?: { personId: string; detectionNumber: number; stepKeys?: Record<string, string> }[];
  sharedStepKeys?: Record<string, string>;
  usedRange: { start: 0; end: number };
  layout?: { preparation: { start: number; end: number }[]; persons: number; composite: { start: number; end: number }[];
    tracking: { forward: { start: number; end: number }[]; reverse: { start: number; end: number }[] } };
  stageJobs?: { stage: string; jobs: number }[];
}

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn(), config: vi.fn() }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

// The shared helpers the panel, admission and pricing share (§97 D12-4); read by name so this file compiles first.
const lip = miniTools as unknown as {
  lipsyncTimeline?: (input: { videoDuration: number; dialogues: readonly Record<string, unknown>[]; syncMode: SyncMode }) => Timeline;
  lipsyncUsedSourceRange?: (timeline: Timeline, anchors: readonly { time: number; windowEnd: number }[]) => { start: 0; end: number };
};
const SYNC = "sync-lipsync-3";
// A served video-to-video talking-head catalog model, standing in for a selectable model that takes no sync_mode.
const NO_SYNC_MODE = "infinitetalk-video-to-video";
const SYNC_FINGERPRINT = "1".repeat(64);
const NO_SYNC_MODE_FINGERPRINT = "2".repeat(64);
// The SAM3 model tracked_mask uses (config/mini-tools.yaml analyses.tracked_mask.profile.id), also its catalog name.
const TRACKER = "sam3-video-rle";
// The presented source (presentation-fixtures): 1011 frames of 1/200 s, display duration V = 5.055 s.
const V = 5.055;
const PEOPLE_PROFILE = { id: "opencv-yunet-2023mar", version: "2023mar", weightsHash: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 } };
const FACE_BOXES = [{ x: 0.1, y: 0.2, width: 0.2, height: 0.3 }, { x: 0.6, y: 0.2, width: 0.2, height: 0.3 }, { x: 0.4, y: 0.5, width: 0.15, height: 0.2 }];
const ACCEPTED_AT = "2026-11-06T08:00:00.123456Z";

let pg: ReturnType<typeof core.createPgClient>;
let queue: Queue;
let app: Hono;
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let lipSync: LipSyncExecution;
let publicUrl: (key: string) => string;
const tokens: string[] = [];

/** Configure a real paid admission with a served (never called) WaveSpeed catalog. @throws {Error} On invalid deployment configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", STRIPE_SECRET_KEY: "sk_test_unused_lipsync",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_lipsync", WAVESPEED_API_KEY: "unused-by-lipsync-admission-tests", UPLOAD_BASE_URL: "https://assets.example.test" });
}

/** The lip-sync execution configuration the design fixes (execution design §9.3; frames-split §7.11). @throws {never} Never. */
function lipSyncConfig(): LipSyncExecution {
  return { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1, max_outputs_per_job: 1,
    models: [
      { name: SYNC, schema_fingerprint: SYNC_FINGERPRINT, min_duration_seconds: 1, max_duration_seconds: 300, crop_size: 512, accepts_sync_mode: true },
      { name: NO_SYNC_MODE, schema_fingerprint: NO_SYNC_MODE_FINGERPRINT, min_duration_seconds: 1, max_duration_seconds: 15, crop_size: 512, accepts_sync_mode: false },
    ],
    tracking: { model: TRACKER, min_duration_seconds: 1, max_duration_seconds: 600 }, max_people: 2, max_dialogues: 8, face_feather: 0.2 };
}

beforeAll(async () => {
  configure(); core.loadLocales(); core.initLogger("lipsync-admission-test");
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "lipsync-admission-fixtures", max: 8 });
  const storage = await core.getStorageAdapter();
  publicUrl = storage.publicUrl.bind(storage);
  queue = core.createQueue("tasks");
  app = (await import("@server/app.js")).createApp();
});
beforeEach(() => {
  configure();
  settings = structuredClone(base); lipSync = lipSyncConfig();
  Reflect.set(settings.executions, "video.lip-sync", lipSync);
  outside.config.mockImplementation(() => settings);
  outside.snapshots.clear(); outside.bodies.clear();
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = outside.bodies.get(url);
    if (body === undefined) throw new Error(`Admission must not fetch an unregistered URL: ${url}`);
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => {
  for (const token of tokens) await core.revokeSession(core.getRedis(), token);
  await pg.end(); core.initCore(process.env); vi.unstubAllGlobals();
});

/**
 * Persist a completed people analysis of the source on the same tool input, as the analysis tests seed one, with real
 * people entries (analysis-record.ts person shape).
 * @param f - The fixture whose draft, Space and source the analysis belongs to.
 * @param binding - The source's server-measured registration.
 * @param sourceKey - Its storage key.
 * @param presented - Its selected tool input.
 * @param count - How many people the detector found.
 * @returns The analysis run id and its input fingerprint.
 * @throws {Error} When the fixture is not a valid completed analysis or SQL fails.
 */
async function seedPeople(f: { userId: string; projectId: string; body: Body }, binding: MiniToolAnalysisRecord["binding"], sourceKey: string, presented: PresentedSource, count: number): Promise<{ analysisRunId: string; inputFingerprint: string; people: string[] }> {
  const { draft, space_id: spaceId, project_id: projectId } = f.body;
  const analysisRunId = randomUUID(); const revision = randomUUID();
  const analysisInput = projectMiniToolAnalysisInput({ kind: "people", source: draft.source, params: { anchor: draft.params.anchor }, profile: PEOPLE_PROFILE });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const people = FACE_BOXES.slice(0, count).map((faceBox, index) => ({ personId: `person-${index + 1}`, faceBox, artifactRefs: [] }));
  const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision, kind: "people" as const, analysisRunId, acceptedAt: ACCEPTED_AT, binding, analysisInput, inputFingerprint };
  const record = miniToolAnalysisRecordSchema.parse({ ...identity, status: "completed", result: { ...identity, anchor: draft.params.anchor, people }, error: null, usage: [], artifactUnavailable: false });
  const analysis = miniToolFrozenAnalysisSchema.parse({ schemaVersion: 1, analysisRunId, projectId, spaceId, hostNodeId: draft.source.nodeId, draftId: draft.draftId, revision,
    kind: "people", source: draft.source, binding, analysisInput, inputFingerprint, presentationRef: presented.presentationRef,
    presentations: { source: presented.bundle }, versionIds: { source: presented.versionId }, chargeTo: "platform" });
  const params = { analysis, requestFingerprint: randomBytes(32).toString("hex"), sourceKey, credits: 0 };
  // Keep the instant textual so its microseconds survive, as seedAccepted does.
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result,created_at)
    VALUES (${analysisRunId},${f.userId},${projectId},${spaceId},'mini_tool_analysis','append','mini_tool','completed',
      ${pg.json(z.json().parse(params))},${pg.json(z.json().parse({ analysis: record }))},${ACCEPTED_AT}::text::timestamptz)`;
  return { analysisRunId, inputFingerprint, people: people.map((person) => person.personId) };
}

/**
 * Register a source video, its selected tool input, audio inputs with measured durations and a completed people
 * analysis, and fund the Studio.
 * @param audio - Each audio input's registered duration and the duration the client claims for it.
 * @param options - The detected people count and the anchor frame.
 * @param options.people - How many people the analysis found.
 * @param options.anchorFrame - The anchor's presentation frame.
 * @returns The fixture with an empty dialogue list.
 * @throws {Error} On fixture SQL failure or invalid analysis fixture.
 */
async function seed(audio: { registered: number; claimed: number }[], options: { people?: number; anchorFrame?: number } = {}): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "lipsync");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
  await seedDesignatedLot(pg, target, 1000);
  const sourceId = randomUUID(); const sourceKey = `video/lipsync/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
  const presented = await presentedSource(hash, sourceKey, publicUrl);
  outside.snapshots.set(sourceKey, presented.snapshot);
  
  const audios: Audio[] = [];
  for (const { registered } of audio) {
    const assetId = randomUUID(); const key = `audio/lipsync/${assetId}.mp3`;
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,duration_seconds)
      VALUES (${assetId},${target.studioId},${randomBytes(32).toString("hex")},${key},${publicUrl(key)},2048,'audio/mpeg','audio','upload',${target.userId},${registered})`;
    audios.push({ inputId: randomUUID(), assetId, url: publicUrl(key), duration: registered });
  }
  const anchorFrame = options.anchorFrame ?? 0;
  const body: Body = { tool: "video.lip-sync", project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
    draft: { version: 1, draftId: randomUUID(), revision: randomUUID(),
      source: { nodeId: randomUUID(), canonicalURL: publicUrl(sourceKey), mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } },
      // The client's own media claims; the plan must use the registered durations instead.
      inputs: audios.map((a, index) => ({ inputId: a.inputId, url: a.url, mediaInfo: { duration: audio[index]!.claimed, mimeType: "audio/mpeg" } })),
      params: { anchor: { frameIndex: anchorFrame }, dialogues: [], syncMode: "cut_off", modelId: SYNC } },
    analysis_refs: [], presentation_ref: presented.presentationRef,
    outputs: [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: "lip-sync" } }] };
  const binding = { assetId: sourceId, contentHash: hash, canonicalURL: publicUrl(sourceKey), kind: "video" as const, mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } };
  const analysis = await seedPeople({ ...target, body }, binding, sourceKey, presented, options.people ?? 3);
  body.analysis_refs = [{ version: 1, draftId: body.draft.draftId, analysisRunId: analysis.analysisRunId, inputFingerprint: analysis.inputFingerprint, toolId: "video.lip-sync", kind: "people" }];
  return { ...target, body, people: analysis.people, audios, analysisRunId: analysis.analysisRunId };
}

/**
 * Set the draft's dialogue rows.
 * @param f - The fixture.
 * @param rows - Each row as [person index, audio index, start time].
 * @returns Nothing.
 * @throws {Error} When an index has no person or audio.
 */
function speak(f: Fixture, rows: [number, number, number][]): void {
  f.body.draft.params.dialogues = rows.map(([person, audio, startTime]) => {
    const personId = f.people[person]; const input = f.audios[audio];
    if (personId === undefined || input === undefined) throw new Error("Dialogue fixture names a missing person or audio");
    return { dialogueId: randomUUID(), personId, analysisRunId: f.analysisRunId, audioInputId: input.inputId, startTime };
  });
}

/** Drive the real HTTP auth, idempotency, validation and planned startup. @throws {Error} On session storage or client failure. */
async function post(f: Fixture, body: unknown = f.body, key = randomUUID()): Promise<Response> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
  return app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(body) });
}

/** Require a real admission. @throws {Error} On assertion failure. */
async function accept(f: Fixture, body: Body = f.body): Promise<void> {
  const response = await post(f, body);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 201, body: { data: { task_id: body.run_id, status: "pending" } } });
}

/** Count only this run's original owners. @throws {Error} On SQL or queue failure. */
async function effects(id: string): Promise<{ tasks: number; rows: number; holds: number; jobs: number }> {
  const [count] = await pg<{ tasks: number; rows: number; holds: number }[]>`SELECT
    (SELECT count(*)::int FROM tasks WHERE id=${id}) AS tasks,
    (SELECT count(*)::int FROM node_tasks WHERE task_id=${id}) AS rows,
    (SELECT count(*)::int FROM credit_holds WHERE reference_id=${id}) AS holds`;
  if (!count) throw new Error("Missing count projection");
  return { ...count, jobs: await queue.getJob(id) ? 1 : 0 };
}

/** Prove the same input is admitted on an independent destination before testing a refusal; returns its run id. @throws {Error} On invalid control. */
async function control(f: Fixture): Promise<string> {
  const body = structuredClone(f.body); body.run_id = randomUUID();
  body.outputs.forEach((output) => { output.nodeId = randomUUID(); });
  await accept(f, body);
  return body.run_id;
}

/**
 * Require a 400 refusal that tells the user why (frames-split §7.11 「否则拒绝并告诉用户原因」; the panel shows it as a
 * toast) and no durable effect.
 * @param f - The fixture.
 * @param reason - The user-facing message key and its values.
 * @param reason.key - The locale key.
 * @param reason.params - Its ICU values.
 * @returns Nothing.
 * @throws {Error} On assertion failure.
 */
async function refused(f: Fixture, reason: { key: string; params?: Record<string, number> }): Promise<void> {
  const response = await post(f);
  const json = await response.json() as { error?: { message?: string; reason?: string } };
  expect({ status: response.status, reason: json.error?.reason, message: json.error?.message })
    .toEqual({ status: 400, reason: undefined, message: shared.t(reason.key, reason.params) });
  expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
}

/**
 * Rewrite the referenced people analysis row after a control was admitted on it.
 * @param id - The analysis run id.
 * @param change - Returns the new status, params and stored record from the current ones.
 * @returns Nothing.
 * @throws {Error} When the row is missing or the rewritten record is invalid.
 */
async function rewriteAnalysis(id: string, change: (current: { params: Record<string, unknown> & { analysis: Record<string, unknown> }; record: Record<string, unknown> }) => { status: string; params?: Record<string, unknown>; record?: Record<string, unknown> }): Promise<void> {
  const [row] = await pg<{ params: Record<string, unknown> & { analysis: Record<string, unknown> }; result: { analysis: Record<string, unknown> } }[]>`SELECT params,result FROM tasks WHERE id=${id}`;
  if (!row) throw new Error("Missing seeded people analysis");
  const next = change({ params: row.params, record: row.result.analysis });
  const params = next.params ?? row.params;
  const record = miniToolAnalysisRecordSchema.parse(next.record ?? row.result.analysis);
  miniToolFrozenAnalysisSchema.parse(params.analysis);
  await pg`UPDATE tasks SET status=${next.status},error_message=${next.status === "failed" ? "analysis_failed" : null},
    params=${pg.json(z.json().parse(params))},result=${pg.json(z.json().parse({ analysis: record }))} WHERE id=${id}`;
}

/** The accepted run's frozen plan. @throws {Error} On a missing task. */
async function plan(id: string): Promise<Plan> {
  const [row] = await pg<{ params: { miniToolExecution: Plan } }[]>`SELECT params FROM tasks WHERE id=${id}`;
  if (!row) throw new Error("Missing accepted lip-sync task");
  return row.params.miniToolExecution;
}

/** The standard-4 container quote at `seconds`, by the rule every container step uses (§5.4). @throws {Error} On invalid prices. */
function std4(seconds: number): number {
  const usd = containerCostUsd({ wallMs: seconds * 1000, cpuUsec: null }, settings.classes.MiniToolContainerStd4!, settings.prices);
  return Math.max(shared.ceilToCreditCent(creditsForUsd(usd, 1)), MIN_TASK_CREDIT_COST);
}

describe("lip-sync fresh admission: frozen generator and timeline (§97; DD §7.1; execution design §9.2, §9.3)", () => {
  it("LA01 admits two referenced people and freezes the sync-3 generator and the timeline from registered audio durations", async () => {
    // Registered 3 s and 2.5 s; the client claims 9 s for both, which would make A = 10.5 and the timeline V.
    const f = await seed([{ registered: 3, claimed: 9 }, { registered: 2.5, claimed: 9 }]);
    // People at result positions 0 and 2 (of three detected), so a counter over the referenced people cannot pass.
    speak(f, [[0, 0, 0], [2, 1, 1.5]]);
    await accept(f);
    const frozen = await plan(f.body.run_id);
    // DD §7.1 persons row: detectionNumber is the person's position in the people result plus 1 (execution design §9.4).
    expect(Object.fromEntries((frozen.persons ?? []).map((person) => [person.personId, person.detectionNumber])))
      .toEqual({ [f.people[0]!]: 1, [f.people[2]!]: 3 });
    expect(frozen.tool).toBe("video.lip-sync");
    expect(frozen.generator).toEqual({ backend: "wavespeed-crop", modelId: SYNC, schemaFingerprint: SYNC_FINGERPRINT, providerSyncMode: "cut_off" });
    // cut_off: min(V, A) with A = max(0 + 3, 1.5 + 2.5) = 4.
    expect(frozen.timeline).toEqual({ duration: 4, videoDuration: V, syncMode: "cut_off" });
    const dialogues = f.body.draft.params.dialogues.map((row, index) => ({ dialogueId: row.dialogueId, personId: row.personId, audioInputId: row.audioInputId, startTime: row.startTime, duration: f.audios[index]!.duration }));
    expect(frozen.timeline).toEqual(lip.lipsyncTimeline!({ videoDuration: V, dialogues, syncMode: "cut_off" }));
    expect(await effects(f.body.run_id)).toEqual({ tasks: 1, rows: 1, holds: 1, jobs: 1 });
  });

  it("LA02 freezes a model that takes no sync_mode with a null provider sync mode and its own schema fingerprint", async () => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]); f.body.draft.params.modelId = NO_SYNC_MODE;
    await accept(f);
    expect((await plan(f.body.run_id)).generator).toEqual({ backend: "wavespeed-crop", modelId: NO_SYNC_MODE, schemaFingerprint: NO_SYNC_MODE_FINGERPRINT, providerSyncMode: null });
  });
});

describe("lip-sync fresh admission refusals and their boundaries (§97; frames-split §7.11 fresh row; execution design §9.3)", () => {
  it.each(["ltx-2.3-lipsync", "no-such-model"])("LA03 refuses a modelId outside the selectable list (%s) after a valid control", async (modelId) => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]); await control(f);
    f.body.draft.params.modelId = modelId;
    await refused(f, { key: "server.mini_tool.lipSyncModelUnavailable" });
  });

  // The planned duration is 4 s; each case moves one end of sync-3's configured range onto or past it.
  it.each([
    ["admits the minimum exactly at the duration", "min_duration_seconds", 4, true],
    ["admits the maximum exactly at the duration", "max_duration_seconds", 4, true],
    ["refuses a minimum above the duration", "min_duration_seconds", 4.01, false],
    ["refuses a maximum below the duration", "max_duration_seconds", 3.99, false],
  ] as const)("LA04 %s of the selected model", async (_name, field, value, admitted) => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    if (!admitted) await control(f);
    lipSync.models[0]![field] = value;
    const { min_duration_seconds: min, max_duration_seconds: max } = lipSync.models[0]!;
    if (admitted) await accept(f); else await refused(f, { key: "server.mini_tool.lipSyncDurationOutOfRange", params: { min, max } });
  });

  // The used source range is [0, 4) for cut_off with the anchor at frame 0; each case moves one end of the tracking range.
  it.each([
    ["admits the minimum exactly at the used range length", "min_duration_seconds", 4, true],
    ["admits the maximum exactly at the used range length", "max_duration_seconds", 4, true],
    ["refuses a minimum above the used range length", "min_duration_seconds", 4.01, false],
    ["refuses a maximum below the used range length", "max_duration_seconds", 3.99, false],
  ] as const)("LA05 %s of the tracking model", async (_name, field, value, admitted) => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    if (!admitted) await control(f);
    lipSync.tracking[field] = value;
    const { min_duration_seconds: min, max_duration_seconds: max } = lipSync.tracking;
    if (admitted) await accept(f); else await refused(f, { key: "server.mini_tool.lipSyncTrackingOutOfRange", params: { min, max } });
  });

  it("LA06 checks the tracking range on the used source range, which reaches the anchor's window, not on the timeline duration", async () => {
    // Anchor at frame 900 (4.5 s, window end 4.505 s): the timeline is still 4 s, the used range [0, 4.505).
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }], { anchorFrame: 900 });
    speak(f, [[0, 0, 0], [1, 1, 1.5]]); await control(f);
    lipSync.models[0]!.max_duration_seconds = 4.25;
    expect((await plan(await control(f))).timeline.duration).toBe(4);
    lipSync.tracking.max_duration_seconds = 4.25;
    await refused(f, { key: "server.mini_tool.lipSyncTrackingOutOfRange", params: { min: 1, max: 4.25 } });
    expect(lip.lipsyncUsedSourceRange!({ duration: 4, videoDuration: V, syncMode: "cut_off" }, [{ time: 4.5, windowEnd: 901 / 200 }])).toEqual({ start: 0, end: 901 / 200 });
  });

  it("LA07 admits exactly two referenced people out of three detected and refuses a third", async () => {
    const f = await seed([{ registered: 1, claimed: 1 }, { registered: 1, claimed: 1 }, { registered: 1, claimed: 1 }], { people: 3 });
    speak(f, [[0, 0, 0], [1, 1, 1]]); await control(f);
    speak(f, [[0, 0, 0], [1, 1, 1], [2, 2, 2]]);
    await refused(f, { key: "server.mini_tool.lipSyncTooManyPeople", params: { max: 2 } });
  });

  it("LA08 admits exactly eight dialogue rows and refuses a ninth", async () => {
    const f = await seed(Array.from({ length: 9 }, () => ({ registered: 0.5, claimed: 0.5 })));
    const rows = Array.from({ length: 9 }, (_, index): [number, number, number] => [index % 2, index, index * 0.5]);
    speak(f, rows.slice(0, 8)); await control(f);
    speak(f, rows);
    await refused(f, { key: "server.mini_tool.lipSyncTooManyDialogues", params: { max: 8 } });
  });
});

// §97 D17-2 (frames-split §7.11 fresh row; DD §7.1 people row): the referenced people analysis is terminal-succeeded, ran
// on the same selected toolInputId as presentation_ref.source, names every row's personId, and every row carries its id.
describe("lip-sync fresh admission against the referenced people analysis (§97 D17-2; DD §7.1 people row)", () => {
  it.each([
    "the analysis still pending", "the analysis failed", "the analysis run on another toolInputId",
    "a row naming a person not in the result", "a row from another analysis run",
  ])("LA10 refuses %s after a valid control", async (bad) => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]); await control(f);
    if (bad === "the analysis still pending") {
      await rewriteAnalysis(f.analysisRunId, ({ record }) => ({ status: "pending", record: { ...record, status: "pending", result: null } }));
    } else if (bad === "the analysis failed") {
      await rewriteAnalysis(f.analysisRunId, ({ record }) => ({ status: "failed", record: { ...record, status: "failed", result: null, error: { code: "analysis_failed" } } }));
    } else if (bad === "the analysis run on another toolInputId") {
      await rewriteAnalysis(f.analysisRunId, ({ params }) => ({ status: "completed", params: { ...params, analysis: { ...params.analysis,
        presentationRef: { source: { ...f.body.presentation_ref.source, toolInputId: "b".repeat(64) } } } } }));
    } else if (bad === "a row naming a person not in the result") f.body.draft.params.dialogues[1]!.personId = "person-9";
    else f.body.draft.params.dialogues[1]!.analysisRunId = randomUUID();
    // §97 D18: the message says what the user does next: wait for person detection, or detect people again.
    await refused(f, { key: bad === "the analysis still pending" ? "server.mini_tool.lipSyncPeopleRunning" : "server.mini_tool.lipSyncPeopleStale" });
  });
});

describe("lip-sync fresh quote (§97; execution design §9.3 pricing paragraph)", () => {
  it("LA09 quotes generation and tracking once per referenced person plus the standard-4 container work, and holds it", async () => {
    // A = 3 + 2.5 = 5.5 > V, so cut_off gives a timeline of V and a used range of [0, V) for both runs below. The precheck
    // floor dominates the planned container work, so the container term is the same std4(precheck) in both runs and the
    // two quotes differ by exactly one more person's generation and tracking.
    lipSync.precheck_seconds = 20000;
    const gen = await estimateTaskCredits(SYNC, { params: {}, durations: { video: [V], audio: [V] }, sources: ["video", "audio"] });
    const track = await estimateTaskCredits(TRACKER, { params: {}, durations: { video: [V] }, sources: ["video"] });
    // Above the task floor, estimateTaskCredits is the model's own catalog estimate, as the removal quotes its model.
    expect(gen).toBeGreaterThan(MIN_TASK_CREDIT_COST); expect(track).toBeGreaterThan(MIN_TASK_CREDIT_COST);
    const quotes: number[] = [];
    for (const second of [0, 1]) {
      const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
      speak(f, [[0, 0, 0], [second, 1, 3]]);
      await accept(f);
      const frozen = await plan(f.body.run_id);
      expect(frozen.timeline).toEqual({ duration: V, videoDuration: V, syncMode: "cut_off" });
      const [hold] = await pg<{ amount: number; status: string }[]>`SELECT amount::float8,status FROM credit_holds WHERE reference_id=${f.body.run_id}`;
      expect(hold).toEqual({ amount: frozen.credits, status: "held" });
      quotes.push(frozen.credits);
    }
    expect(quotes[0]).toBeCloseTo(gen + track + std4(20000), 6);
    expect(quotes[1]).toBeCloseTo(2 * (gen + track) + std4(20000), 6);
    expect(quotes[1]! - quotes[0]!).toBeCloseTo(gen + track, 6);
  });

  // Execution design §10.2 last paragraph: tracking is priced per person per clip over its encoded length; the anchor at
  // frame 0 tracks the used range forward only, a middle anchor tracks [a, e) forward and [0, a] reversed, and the last
  // frame tracks only the reversed clip. The precheck floor dominates the container work, as in LA09.
  it.each([
    ["a middle frame", 500, [511, 501]],
    ["the last frame", 1010, [1011]],
  ] as const)("LA11 an anchor on %s quotes tracking once per clip it tracks", async (_case, anchorFrame, clipFrames) => {
    lipSync.precheck_seconds = 20000;
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }], { anchorFrame });
    speak(f, [[0, 0, 0], [0, 1, 3]]);
    await accept(f);
    const frozen = await plan(f.body.run_id);
    expect(frozen.usedRange).toEqual({ start: 0, end: V });
    const gen = await estimateTaskCredits(SYNC, { params: {}, durations: { video: [V], audio: [V] }, sources: ["video", "audio"] });
    let track = 0;
    for (const frames of clipFrames) track += await estimateTaskCredits(TRACKER, { params: {}, durations: { video: [frames / 200] }, sources: ["video"] });
    expect(frozen.credits).toBeCloseTo(gen + track + std4(20000), 6);
    expect(Object.keys(frozen.sharedStepKeys ?? {}).filter((key) => key.startsWith("prepare:")).sort()).toEqual(clipFrames.length === 2 ? ["prepare:fwd", "prepare:rev"] : ["prepare:rev"]);
  });
});

// frames-split §5.4 上限 row: lip-sync's stages are prepare, faces (persons), clip and stem (2 × persons), composite chunks
// and stitch; the largest is compared with `encoding.max_parallel_chunks`, counted by the shared `plannedStageJobs`, and
// the layout and its stage counts are frozen beside each other as split freezes them (§97 D12-1).
describe("lip-sync stage job counts at admission (§97 D12-1; frames-split §5.4 派发, 预算, 上限 rows)", () => {
  it("LS01 freezes the layout and its stage counts, two people's clip and stem being four jobs", async () => {
    settings.encoding.max_parallel_chunks = 4;
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    await accept(f);
    const frozen = await plan(f.body.run_id);
    expect(frozen.layout?.persons).toBe(2);
    for (const windows of [frozen.layout?.preparation, frozen.layout?.composite]) {
      expect(windows?.length).toBeGreaterThan(0);
      for (const window of windows ?? []) expect(window.end).toBeGreaterThan(window.start);
    }
    expect(frozen.stageJobs).toEqual(miniTools.plannedStageJobs(frozen.layout!));
    expect(frozen.stageJobs).toContainEqual({ stage: "clip_stem", jobs: 4 });
  });

  it("LS02 refuses two people whose clip and stem stage exceeds the cap with runTooLong, after one person is admitted", async () => {
    settings.encoding.max_parallel_chunks = 3;
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    // One person: clip and stem is two jobs, within the cap, so the refusal below is the cap and not the fixture.
    speak(f, [[0, 0, 0], [0, 1, 1.5]]);
    const one = await plan(await control(f));
    expect(one.stageJobs).toContainEqual({ stage: "clip_stem", jobs: 2 });
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    await refused(f, { key: "server.mini_tool.runTooLong", params: { max: 3 } });
  });

  // Execution design §10.2: the anchor at frame 500 reverses the frames [0, 500] through the reverse buffer, which at the
  // 960x540 prepared size holds 100 of them: six reversed chunks sent with prepare:fwd at once, then their stitch. Their
  // count depends only on how far the anchor lies from the start, so the refusal names the anchor, not the outputs; any
  // other stage over the cap keeps runTooLong (LS02).
  it("LS03 freezes the reversed clip's chunks from the reverse buffer and refuses them over the parallel cap with lipSyncAnchorTooLate", async () => {
    settings.encoding.reverse_buffer_bytes = 100 * 960 * 540 * 1.5;
    settings.encoding.max_parallel_chunks = 7;
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }], { anchorFrame: 500 });
    speak(f, [[0, 0, 0], [0, 1, 3]]);
    const frozen = await plan(await control(f));
    const tracking = frozen.layout!.tracking;
    expect(tracking.forward).toEqual([{ start: 500, end: 1011 }]);
    expect(tracking.reverse).toHaveLength(6);
    expect(tracking.reverse.at(-1)).toEqual({ start: 500, end: 501 });
    expect(frozen.stageJobs).toContainEqual({ stage: "track_prepare", jobs: 7 });
    expect(frozen.stageJobs).toContainEqual({ stage: "track_prepare_stitch", jobs: 1 });
    settings.encoding.max_parallel_chunks = 6;
    await refused(f, { key: "server.mini_tool.lipSyncAnchorTooLate" });
  });
});

// Execution design §9.3 pricing paragraph: the quote is per person (generation over `timeline.duration` + tracking over
// the used range) plus the container work (preparation, each person's lipsync_faces, lipsync_clip and lipsync_stem, the
// composite chunks and the stitch) under the one container quote rule. The per-step formulas are not fixed (frames-split
// §5.4 待实测 row), so these cases assert only relations between container terms.
describe("lip-sync quote container work (§97; execution design §9.3; frames-split §5.4 待实测 row)", () => {
  /**
   * Make planned container work dominate the precheck floor and the task minimum: the floor is one second, and encoding
   * runs at one display frame per second with negligible decode, so each step's seconds lie far above credit-cent rounding.
   * @returns Nothing.
   * @throws {never} Never.
   */
  function plannedWorkDominates(): void {
    lipSync.precheck_seconds = 1;
    const encoder = settings.encoding.encoder;
    encoder.encode_pixels_per_second = 960 * 540;
    for (const key of Object.keys(encoder.decode_convert_pixels_per_second) as (keyof typeof encoder.decode_convert_pixels_per_second)[]) {
      encoder.decode_convert_pixels_per_second[key] = 1e15;
    }
  }
  /**
   * Admit the fixture and return its container term: the quote minus each person's generation over the run's own
   * timeline and tracking over its own used range, computed as the admission computes them.
   * @param f - The fixture with its rows set.
   * @param people - The referenced people.
   * @returns The frozen plan and its container credits.
   * @throws {Error} On admission or pricing failure.
   */
  async function containerTerm(f: Fixture, people: number): Promise<{ frozen: Plan; container: number }> {
    await accept(f);
    const frozen = await plan(f.body.run_id);
    const { duration } = frozen.timeline;
    const gen = await estimateTaskCredits(SYNC, { params: {}, durations: { video: [duration], audio: [duration] }, sources: ["video", "audio"] });
    const track = await estimateTaskCredits(TRACKER, { params: {}, durations: { video: [frozen.usedRange.end - frozen.usedRange.start] }, sources: ["video"] });
    return { frozen, container: frozen.credits - people * (gen + track) };
  }

  it("LQ01 adds each referenced person's own container steps to the container work", async () => {
    plannedWorkDominates();
    const terms: number[] = [];
    // The same rows as LA09: A = 5.5 > V, so cut_off gives the timeline V and the used range [0, V) for both runs.
    for (const second of [0, 1]) {
      const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
      speak(f, [[0, 0, 0], [second, 1, 3]]);
      const { frozen, container } = await containerTerm(f, second + 1);
      expect(frozen.timeline.duration).toBe(V);
      expect(container).toBeGreaterThan(std4(1));
      terms.push(container);
    }
    // A second person adds its lipsync_faces, lipsync_clip and lipsync_stem: at least one credit cent more.
    expect(terms[1]! - terms[0]!).toBeGreaterThanOrEqual(0.01);
  });

  it("LQ02 scales the container work with the timeline in loop mode, whose used source range stays [0, V)", async () => {
    plannedWorkDominates();
    const terms: number[] = [];
    // loop: the timeline is the audio end A, 5.5 s then 11 s; the used range is [0, V) in both.
    for (const second of [2.5, 8]) {
      const f = await seed([{ registered: 3, claimed: 3 }, { registered: second, claimed: second }]);
      speak(f, [[0, 0, 0], [1, 1, 3]]); f.body.draft.params.syncMode = "loop";
      const { frozen, container } = await containerTerm(f, 2);
      expect(frozen.timeline.duration).toBe(3 + second);
      expect(frozen.usedRange).toEqual({ start: 0, end: V });
      terms.push(container);
    }
    // Composite chunks, stitch, clip and stem all cover the longer result: at least one credit cent more.
    expect(terms[1]! - terms[0]!).toBeGreaterThanOrEqual(0.01);
  });
});

// frames-split §5.4 派发 row: `lipsync_faces`, `lipsync_clip` and `lipsync_stem` run as one unchunked job per person, and
// any of them estimated over one chunk share (remaining budget × `encoding.chunk_share`, 3600 s of the 2 h budget) is
// refused at admission with its reason; the stitch is bound by the same share (coordinator D23-5 (d): every container job
// fits its share). §5.4 待实测 row as implemented: faces = start + used source frames × (source pixels ÷ decode rate +
// source pixels ÷ `encoding.encoder.face_detect_pixels_per_second`) (D23-5 (e)); stem and stitch = start + audio duration ÷
// `encoding.encoder.aac_encode_seconds_per_second`. The refusal has its own reason, `server.mini_tool.lipSyncStepTooLong`
// with no values (D23-5 (c)). Each case admits the run with the job at about 0.9 share, then refuses it at about 1.1 share,
// so only that one rate decides; decode is made negligible so the formula's other terms cannot cross either way.
describe("lip-sync single job over one chunk share (frames-split §5.4 派发 and 待实测 rows)", () => {
  /**
   * One person speaking 4 s in cut_off: timeline 4 s, used source range [0, 4) = 800 frames of 1/200 s at 960 × 540.
   * @returns The fixture.
   * @throws {Error} On fixture failure.
   */
  async function onePerson(): Promise<Fixture> {
    const encoder = settings.encoding.encoder;
    for (const key of Object.keys(encoder.decode_convert_pixels_per_second) as (keyof typeof encoder.decode_convert_pixels_per_second)[]) {
      encoder.decode_convert_pixels_per_second[key] = 1e15;
    }
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [0, 1, 1.5]]);
    return f;
  }

  it("LJ01 refuses a run whose lipsync_faces alone exceeds one chunk share, after the same run is admitted just within it", async () => {
    const f = await onePerson();
    // 800 frames × 960 × 540 pixels at 129600 pixels per second = 3200 s of detection, within the 3600 s share.
    settings.encoding.encoder.face_detect_pixels_per_second = (800 * 960 * 540) / 3200;
    const admitted = await plan(await control(f));
    expect(admitted.usedRange).toEqual({ start: 0, end: 4 });
    // At 103680 pixels per second the one faces job takes 4000 s, over the share; nothing else changed.
    settings.encoding.encoder.face_detect_pixels_per_second = (800 * 960 * 540) / 4000;
    await refused(f, { key: "server.mini_tool.lipSyncStepTooLong" });
  });

  // The implementation estimates the stitch exactly like each stem (start + the result duration ÷ the AAC rate), so no
  // configuration moves one over the share without the other: this case covers the stem and the stitch together.
  it("LJ02 refuses a run whose lipsync_stem and stitch exceed one chunk share, after the same run is admitted just within it", async () => {
    const f = await onePerson();
    // The 4 s result audio at 4/3200 audio seconds per second takes 3200 s.
    settings.encoding.encoder.aac_encode_seconds_per_second = 4 / 3200;
    expect((await plan(await control(f))).timeline.duration).toBe(4);
    settings.encoding.encoder.aac_encode_seconds_per_second = 4 / 4000;
    await refused(f, { key: "server.mini_tool.lipSyncStepTooLong" });
  });
});

// Execution design paragraph before §9.4: composite chunks are cut by the chunk share and may span loop and bounce segment
// boundaries; a chunk whose source frames go back decodes its union source window to a raw file, which must fit the raw disk
// budget computed once at admission and frozen into the plan. Checked through the shared `lipsyncSourceFrameAt` on the
// source's own grid (presentation-fixtures REMOVAL_DISPLAY: 1011 frames at 200 fps).
describe("lip-sync composite chunks span segments within the frozen raw disk budget (execution design paragraph before §9.4)", () => {
  it("LJ03 freezes a bounce run whose source window fits the disk as one chunk across the reversal, and freezes the disk budget", async () => {
    // A = max(0 + 3, 3 + 5) = 8 > V: bounce plays [0, V] forward and comes back from V; 1600 result frames of 1/200 s.
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 5, claimed: 5 }]);
    speak(f, [[0, 0, 0], [1, 1, 3]]); f.body.draft.params.syncMode = "bounce";
    await accept(f);
    const frozen = await plan(f.body.run_id);
    expect(frozen.timeline).toEqual({ duration: 8, videoDuration: V, syncMode: "bounce" });
    const grid = { fps: { numerator: 200, denominator: 1 }, frameCount: 1011 };
    const shown = Array.from({ length: 1600 }, (_, at) => miniTools.lipsyncSourceFrameAt(frozen.timeline, grid, at));
    expect(shown.some((frame, at) => at > 0 && frame < shown[at - 1]!), "the result goes back through the source").toBe(true);
    // 1011 frames of 960 × 540 at 4:2:0 are about 0.8 GB, within half of standard-4's 20 GB disk.
    expect(frozen.layout?.composite).toEqual([{ start: 0, end: 1600 }]);
    const container = frozen.container as { rawDiskBytes?: number };
    expect(container.rawDiskBytes).toBe(Math.floor(settings.classes.MiniToolContainerStd4!.disk_gb * 1e9 * settings.encoding.raw_disk_share));
    expect(frozen.stageJobs).toEqual(miniTools.plannedStageJobs(frozen.layout!));
    // The composite's face feather is frozen beside the disk budget (DD §7.2 step 6).
    expect((frozen as { faceFeather?: number }).faceFeather).toBe(lipSync.face_feather);
  });
});

// Retry admission (frames-split §7.11 retry row; execution design §9.4; §97 D21-6, D24; frames-split §7.15 retry rows). The
// original is admitted through HTTP, then left as the worker leaves a failed lip-sync run: started and finished through
// the domain completion entry with output 0 failed on a §9.4 reason, a derived step object appended to its execution pin
// and a prepared input pinned while it ran, its node task settled and its hold released. A retry is admitted only when
// shared `lipsyncFailureRetryable` holds for that reason; it then freezes the same plan with each person's original step
// keys and takes over the failed output, pinning what the original held before the original's pins are released.
describe("lip-sync retry admission (frames-split §7.11 retry row, §7.15; execution design §9.4)", () => {
  interface Failed { plan: Plan & { planFingerprint: string; sourceKey: string; outputs: unknown[] }; row: unknown; pins: Pin[]; steps: string[]; prepared: string }
  interface Pin { holder_kind: string; tool_input_id: string; prepared_key: string | null; keys: string[] }
  const person = (index: number, step: string, category: string): Record<string, unknown> => ({ personId: `person-${index}`, detectionNumber: index, step, category });

  /** The retry body for output 0 of the fixture's original. @throws {never} Never. */
  function retryBody(f: Fixture, run = randomUUID()): { tool: "video.lip-sync"; project_id: string; space_id: string; run_id: string; retry: { runId: string; outputIndexes: number[] } } {
    return { tool: "video.lip-sync", project_id: f.projectId, space_id: f.body.space_id, run_id: run, retry: { runId: f.body.run_id, outputIndexes: [0] } };
  }

  /**
   * Require the original's frozen step keys to be present, so equality with them is not equality of two absent values:
   * per person the forward track (these fixtures anchor on the first frame), the join, faces, clip, stem and gen, and the
   * shared composite and stitch keys, every one a 64-hex digest (DD §7.1 steps row; execution design §10.2).
   * @param frozen - The original's frozen plan, read from its task's `params.miniToolExecution`.
   * @returns Nothing.
   * @throws {Error} On assertion failure.
   */
  function frozenStepKeys(frozen: Failed["plan"]): void {
    for (const p of frozen.persons ?? []) expect(Object.keys(p.stepKeys ?? {}).sort()).toEqual(["clip", "faces", "gen", "stem", "track:fwd", "track_join"]);
    expect(Object.keys(frozen.sharedStepKeys ?? {})).toContain("stitch");
    expect(Object.keys(frozen.sharedStepKeys ?? {}).some((step) => step.startsWith("composite:"))).toBe(true);
    for (const key of [...(frozen.persons ?? []).flatMap((p) => Object.values(p.stepKeys ?? {})), ...Object.values(frozen.sharedStepKeys ?? {})]) expect(key).toMatch(/^[a-f0-9]{64}$/);
  }

  /** A run's live pins with their keys. @throws {Error} On SQL failure. */
  async function livePins(holderId: string): Promise<Pin[]> {
    return [...await pg<Pin[]>`SELECT p.holder_kind,p.tool_input_id,p.prepared_key,
        coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL), '{}') AS keys
      FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
      WHERE p.holder_id=${holderId} AND p.deleted_at IS NULL GROUP BY p.id ORDER BY p.holder_kind,p.prepared_key`];
  }

  /** The original's task row as the retry must leave it. @throws {Error} On SQL failure. */
  async function taskRow(id: string): Promise<unknown> {
    const [row] = await pg`SELECT status,params,result,error_message,completed_at::text FROM tasks WHERE id=${id}`;
    return row;
  }

  /**
   * Admit two people speaking and leave the run failed on `reason`, as the worker leaves it.
   * @param reason - The §9.4 reason on failed output 0 and on the run.
   * @returns The fixture and the original's facts.
   * @throws {Error} On admission, completion or fixture SQL failure.
   */
  async function failedLipSync(reason: Record<string, unknown>): Promise<{ f: Fixture; original: Failed }> {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    await accept(f);
    const id = f.body.run_id;
    const frozen = await plan(id) as Failed["plan"];
    const toolInputId = f.body.presentation_ref.source.toolInputId;
    await miniToolExecutionService.startMiniToolExecution(id, `lipsync-${id}`);
    // A done track step's object, appended to the execution pin in its registration transaction (§97 D17-7), and the
    // prepared input pinned by the worker's preparation registration (§7.15 prepared row).
    const steps = [`${frozen.sourceKey}.${id}:lipsync:${frozen.persons![0]!.stepKeys!.track}.json`];
    const prepared = `${frozen.sourceKey}.${id}:prep:0:a1`;
    await core.db.transaction(async (tx) => appendPinObjects("execution", id, steps, tx));
    await presentationPinService.acquire({ holderKind: "prepared", holderId: id, toolInputId, preparedKey: prepared, objectKeys: [prepared] });
    await finishFailed(id, reason);
    return { f, original: { plan: frozen, row: await taskRow(id), pins: await livePins(id), steps, prepared } };
  }

  /**
   * End a started run as the worker ends a failed one: the terminal commit with output 0 failed on `reason`, the node task
   * settled (settleTaskForNode's SQL effect) and the hold released.
   * @param id - The run.
   * @param reason - The §9.4 reason.
   * @returns Nothing.
   * @throws {Error} On completion or fixture SQL failure.
   */
  async function finishFailed(id: string, reason: Record<string, unknown>): Promise<void> {
    const frozen = await plan(id) as Failed["plan"];
    const outputs = frozen.outputs as { outputIndex: number; nodeId: string; recipe: { kind: "lip-sync" } }[];
    const error = z.record(z.string(), z.json()).parse(reason);
    await miniToolExecutionService.finishMiniToolExecution(id, { planFingerprint: frozen.planFingerprint, expectedVersion: 0,
      error, outputs: outputs.map((output) => ({ ...output, late: false, result: { status: "failed", error } })) });
    await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${id}`;
    await creditHoldService.releaseHold(id);
  }

  it.each([
    ["every person timing out or failing", { kind: "lipsync", persons: [person(1, "gen", "timeout"), person(2, "clip", "failed")], shared: null }],
    ["failed people beside a failed shared stitch", { kind: "lipsync", persons: [person(1, "gen", "failed")], shared: { step: "stitch", category: "failed" } }],
  ])("LR01 admits a retry of %s on the same frozen plan and the original's step keys, taking over the failed output", async (_name, reason) => {
    const { f, original } = await failedLipSync(reason);
    expect(original.pins.map((pin) => pin.holder_kind)).toEqual(["execution", "prepared"]);
    const body = retryBody(f);
    await accept(f, body as unknown as Body);
    const retried = await plan(body.run_id) as Failed["plan"] & { retry: unknown; targetNodeIds: string[] };
    for (const field of ["tool", "generator", "timeline", "usedRange", "dialogues", "layout", "stageJobs", "tracking", "cropSize"]) {
      expect(retried[field], field).toEqual(original.plan[field]);
    }
    frozenStepKeys(original.plan);
    expect(retried.persons).toEqual(original.plan.persons);
    expect(retried.sharedStepKeys).toEqual(original.plan.sharedStepKeys);
    expect(retried.persons?.map((p) => [p.personId, p.detectionNumber])).toEqual([["person-1", 1], ["person-2", 2]]);
    // Takeover: the original's failed slot and node, a task, node task, hold and job of its own, the original unchanged.
    expect(retried.outputs).toEqual(original.plan.outputs);
    expect(retried.targetNodeIds).toEqual([f.body.outputs[0]!.nodeId]);
    expect(retried.retry).toEqual({ runId: f.body.run_id, outputIndexes: [0] });
    expect(await effects(body.run_id)).toEqual({ tasks: 1, rows: 1, holds: 1, jobs: 1 });
    expect([...await pg`SELECT node_id,status FROM node_tasks WHERE task_id=${body.run_id}`]).toEqual([{ node_id: f.body.outputs[0]!.nodeId, status: "running" }]);
    expect(await taskRow(f.body.run_id)).toEqual(original.row);
  });

  it.each([
    ["no_face", { kind: "lipsync", persons: [person(1, "faces", "no_face"), person(2, "gen", "timeout")], shared: null }],
    ["model_rejected beside a stopped person", { kind: "lipsync", persons: [person(1, "gen", "model_rejected"), person(2, "track", "stopped")], shared: null }],
  ])("LR02 refuses a retry of a %s failure as a slot that cannot be retried, with no durable effect", async (_name, reason) => {
    const { f, original } = await failedLipSync(reason);
    const body = retryBody(f);
    const response = await post(f, body);
    const json = await response.json() as { error?: { message?: string } };
    // The existing refusal for a selected slot that cannot be retried: claimRetry's ValidationError (422).
    expect({ status: response.status, message: json.error?.message }).toEqual({ status: 422, message: shared.t("server.mini_tool.foreignSource") });
    expect(await effects(body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
    expect(await taskRow(f.body.run_id)).toEqual(original.row);
    expect(await livePins(f.body.run_id)).toEqual(original.pins);
    expect(await livePins(body.run_id)).toEqual([]);
  });

  it("LR03 replays the same retry under the same key and refuses a different run on the taken-over output", async () => {
    const { f } = await failedLipSync({ kind: "lipsync", persons: [person(1, "gen", "timeout")], shared: null });
    const body = retryBody(f); const key = randomUUID();
    expect((await post(f, body, key)).status).toBe(201);
    const first = await taskRow(body.run_id);
    const again = await post(f, body, key);
    expect({ status: again.status, body: await again.json() }).toEqual({ status: 201, body: { data: { task_id: body.run_id, status: "pending" } } });
    expect(await taskRow(body.run_id)).toEqual(first);
    expect(await effects(body.run_id)).toEqual({ tasks: 1, rows: 1, holds: 1, jobs: 1 });
    // A second run on the same failed output: the first retry took it over, so it accepts no further retry (frames-split §7.15).
    const other = retryBody(f);
    const response = await post(f, other);
    expect({ status: response.status, message: (await response.json() as { error?: { message?: string } }).error?.message })
      .toEqual({ status: 422, message: shared.t("server.mini_tool.alreadyRetried") });
    expect(await effects(other.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });

  it("LR04 pins every object of the original's execution pin and each prepared input for the retry, then releases the original's pins", async () => {
    const { f, original } = await failedLipSync({ kind: "lipsync", persons: [person(1, "gen", "failed"), person(2, "stem", "timeout")], shared: null });
    const held = original.pins.find((pin) => pin.holder_kind === "execution")!;
    expect(held.keys).toEqual(expect.arrayContaining(original.steps));
    const body = retryBody(f);
    await accept(f, body as unknown as Body);
    const pins = await livePins(body.run_id);
    expect(pins.find((pin) => pin.holder_kind === "execution")?.keys).toEqual(expect.arrayContaining(held.keys));
    expect(pins.filter((pin) => pin.holder_kind === "prepared")).toEqual(original.pins.filter((pin) => pin.holder_kind === "prepared"));
    expect(pins.filter((pin) => pin.holder_kind === "prepared").map((pin) => pin.prepared_key)).toEqual([original.prepared]);
    expect(await livePins(f.body.run_id)).toEqual([]);
    // Pinned by the retry before the original's release, so nothing the retry reuses was registered for reclaim.
    expect([...await pg`SELECT storage_key FROM storage_reclaim_queue WHERE starts_with(storage_key, ${original.plan.sourceKey})`]).toEqual([]);
  });

  it("LR05 a retry of a failed retry keeps the original's step keys and plan and takes over every object the first retry held", async () => {
    const { f, original } = await failedLipSync({ kind: "lipsync", persons: [person(1, "gen", "timeout"), person(2, "gen", "failed")], shared: null });
    const first = retryBody(f);
    await accept(f, first as unknown as Body);
    await miniToolExecutionService.startMiniToolExecution(first.run_id, `lipsync-${first.run_id}`);
    // The first retry's own done step: its key is the original's, the object it registers is new (§97 D17-7).
    const extra = `${original.plan.sourceKey}.${first.run_id}:lipsync:${original.plan.persons![1]!.stepKeys!.gen}.mp4`;
    await core.db.transaction(async (tx) => appendPinObjects("execution", first.run_id, [extra], tx));
    await finishFailed(first.run_id, { kind: "lipsync", persons: [person(2, "gen", "timeout")], shared: { step: "composite", category: "failed" } });
    const held = await livePins(first.run_id);
    const heldExecution = held.find((pin) => pin.holder_kind === "execution")!;
    expect(heldExecution.keys).toEqual(expect.arrayContaining([...original.steps, extra]));
    expect(held.filter((pin) => pin.holder_kind === "prepared").map((pin) => pin.prepared_key)).toEqual([original.prepared]);

    const second = { ...retryBody(f), retry: { runId: first.run_id, outputIndexes: [0] } };
    await accept(f, second as unknown as Body);
    const chained = await plan(second.run_id) as Failed["plan"] & { targetNodeIds: string[] };
    for (const field of ["tool", "generator", "timeline", "usedRange", "dialogues", "layout", "stageJobs", "tracking", "cropSize", "outputs"]) {
      expect(chained[field], field).toEqual(original.plan[field]);
    }
    frozenStepKeys(original.plan);
    expect(chained.persons).toEqual(original.plan.persons);
    expect(chained.sharedStepKeys).toEqual(original.plan.sharedStepKeys);
    expect(chained.targetNodeIds).toEqual([f.body.outputs[0]!.nodeId]);
    expect(await effects(second.run_id)).toEqual({ tasks: 1, rows: 1, holds: 1, jobs: 1 });
    const pins = await livePins(second.run_id);
    expect(pins.find((pin) => pin.holder_kind === "execution")?.keys).toEqual(expect.arrayContaining(heldExecution.keys));
    expect(pins.filter((pin) => pin.holder_kind === "prepared")).toEqual(held.filter((pin) => pin.holder_kind === "prepared"));
    expect(await livePins(first.run_id)).toEqual([]);
    expect(await livePins(f.body.run_id)).toEqual([]);
    expect([...await pg`SELECT storage_key FROM storage_reclaim_queue WHERE starts_with(storage_key, ${original.plan.sourceKey})`]).toEqual([]);
  });

  it("LR06 refuses a retry while the original still runs, with no durable effect and its pins kept (§7.15: retryability ends only at a terminal state)", async () => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    await accept(f);
    const id = f.body.run_id;
    const frozen = await plan(id) as Failed["plan"];
    await miniToolExecutionService.startMiniToolExecution(id, `lipsync-${id}`);
    const prepared = `${frozen.sourceKey}.${id}:prep:0:a1`;
    await core.db.transaction(async (tx) => appendPinObjects("execution", id, [`${frozen.sourceKey}.${id}:lipsync:${frozen.persons![0]!.stepKeys!.track}.json`], tx));
    await presentationPinService.acquire({ holderKind: "prepared", holderId: id, toolInputId: f.body.presentation_ref.source.toolInputId, preparedKey: prepared, objectKeys: [prepared] });
    const row = await taskRow(id); const pins = await livePins(id);
    expect((row as { status: string }).status).toBe("running");
    expect(pins.map((pin) => pin.holder_kind)).toEqual(["execution", "prepared"]);
    const body = retryBody(f);
    const response = await post(f, body);
    // claimRetry reaches the selected slot's check first: output 0 has no result yet, so it is not a failed slot (422),
    // before the active-node check that would answer 409.
    expect({ status: response.status, message: (await response.json() as { error?: { message?: string } }).error?.message })
      .toEqual({ status: 422, message: shared.t("server.mini_tool.foreignSource") });
    expect(await effects(body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
    expect(await taskRow(id)).toEqual(row);
    expect(await livePins(id)).toEqual(pins);
    expect(await livePins(body.run_id)).toEqual([]);
  });
});

// §97 D26-1: the panel's quote is the server's own admission computation with no side effect. `POST /api/v1/mini-tools/quote`
// takes the same JSON body as `POST /api/v1/mini-tools` (no Idempotency-Key), checks auth and project access as admission
// does, and answers 200 `{ data: { credits } }` with the credits admission would freeze (task minimum floor included); a
// body admission refuses is refused with the same status and message.
describe("lip-sync quote (§97 D26-1)", () => {
  /** Ask for the quote of a planned body through real HTTP auth. @throws {Error} On session storage or client failure. */
  async function quote(f: Fixture, body: unknown = f.body): Promise<Response> {
    const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
    return app.request("/api/v1/mini-tools/quote", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(body) });
  }
  /** Every pin row (live or released) a run holds. @throws {Error} On SQL failure. */
  async function pinRows(id: string): Promise<number> {
    const [row] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM presentation_pins WHERE holder_id=${id}`;
    return row!.n;
  }

  it.each([
    ["one person", [[0, 0, 0], [0, 1, 1.5]]],
    ["two people", [[0, 0, 0], [1, 1, 1.5]]],
  ] as [string, [number, number, number][]][])("LQ10 quotes %s with exactly the credits admission then freezes for the same body", async (_name, rows) => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, rows);
    const response = await quote(f);
    expect(response.status).toBe(200);
    const json = await response.json() as { data?: { credits?: unknown } };
    expect(typeof json.data?.credits).toBe("number");
    await accept(f);
    expect((await plan(f.body.run_id)).credits).toBe(json.data?.credits);
  });

  it("LQ11 a quote writes no task, node task, hold, job or pin for the run", async () => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    expect((await quote(f)).status).toBe(200);
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
    expect(await pinRows(f.body.run_id)).toBe(0);
  });

  it.each([
    ["a third referenced person", "server.mini_tool.lipSyncTooManyPeople", { max: 2 }],
    ["a used range over the tracking maximum", "server.mini_tool.lipSyncTrackingOutOfRange", { min: 1, max: 3.99 }],
  ] as const)("LQ12 refuses %s exactly as admission does, writing nothing", async (bad, key, params) => {
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }, { registered: 1, claimed: 1 }]);
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    // A valid quote of the same fixture first, so the refusal below is the changed fact and not the fixture or a missing route.
    expect((await quote(f)).status).toBe(200);
    if (bad === "a third referenced person") speak(f, [[0, 0, 0], [1, 1, 1.5], [2, 2, 2]]);
    else lipSync.tracking.max_duration_seconds = 3.99;
    const quoted = await quote(f);
    const answer = { status: quoted.status, message: (await quoted.json() as { error?: { message?: string } }).error?.message };
    expect(answer).toEqual({ status: 400, message: shared.t(key, params) });
    const admitted = await post(f);
    expect({ status: admitted.status, message: (await admitted.json() as { error?: { message?: string } }).error?.message }).toEqual(answer);
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
    expect(await pinRows(f.body.run_id)).toBe(0);
  });
});
