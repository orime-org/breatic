// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Lip-sync execution admission (inner#1306 test plan §97; frames-split design §7.11 fresh row and §5.4 上限 row; execution
 * design §9.2, §9.3 with its pricing paragraph, §9.4; multi-person lip-sync DD §7.1 frozen plan table).
 *
 * Real admission, authorization, PG, Redis, holds and queue; only the external presentation snapshot (ingest) and the
 * stored ledger objects (fetch) are controlled, as in planned-video-admission. A fresh lip-sync run is admitted only when
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
import { containerCostUsd, creditsForUsd, estimateTaskCredits, miniToolFrozenAnalysisSchema, MIN_TASK_CREDIT_COST } from "@breatic/domain";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { presentedSource, type PresentedSource } from "./presentation-fixtures.js";

type SyncMode = "cut_off" | "silence" | "loop" | "bounce" | "remap";
interface LipSyncModel { name: string; schema_fingerprint: string; min_duration_seconds: number; max_duration_seconds: number; crop_size: number; accepts_sync_mode: boolean }
interface LipSyncExecution {
  container_class: string; precheck_seconds: number; max_outputs: number; max_outputs_per_job: number; models: LipSyncModel[];
  tracking: { model: string; min_duration_seconds: number; max_duration_seconds: number }; max_people: number; max_dialogues: number;
}
interface Row { dialogueId: string; personId: string; analysisRunId: string; audioInputId: string; startTime: number }
interface Body {
  tool: "video.lip-sync"; project_id: string; space_id: string; run_id: string;
  draft: {
    version: 1; draftId: string; revision: string;
    source: { nodeId: string; canonicalURL: string; mediaInfo: { width: number; height: number; duration: number; mimeType: string } };
    inputs: { inputId: string; url: string; mediaInfo: { duration: number; mimeType: string } }[];
    params: { anchor: { frameIndex: number; pts: number }; dialogues: Row[]; syncMode: SyncMode; modelId: string };
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
    tracking: { model: TRACKER, min_duration_seconds: 1, max_duration_seconds: 600 }, max_people: 2, max_dialogues: 8 };
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
    ledgerReceipts: { source: presented.receipt }, versionIds: { source: presented.versionId } });
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
  for (const [url, body] of presented.bodies) outside.bodies.set(url, body);
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
      params: { anchor: { frameIndex: anchorFrame, pts: anchorFrame / 200 }, dialogues: [], syncMode: "cut_off", modelId: SYNC } },
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
 * Require a refusal the user can read (a value refusal, not a stale-page structure refusal) and no durable effect.
 * @param f - The fixture.
 * @returns Nothing.
 * @throws {Error} On assertion failure.
 */
async function refused(f: Fixture): Promise<void> {
  const response = await post(f);
  const json = await response.json() as { error?: { message?: string; reason?: string } };
  expect({ status: response.status, reason: json.error?.reason, explained: (json.error?.message ?? "").length > 0 }).toEqual({ status: 400, reason: undefined, explained: true });
  expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
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
    speak(f, [[0, 0, 0], [1, 1, 1.5]]);
    await accept(f);
    const frozen = await plan(f.body.run_id);
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
    await refused(f);
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
    if (admitted) await accept(f); else await refused(f);
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
    if (admitted) await accept(f); else await refused(f);
  });

  it("LA06 checks the tracking range on the used source range, which reaches the anchor's window, not on the timeline duration", async () => {
    // Anchor at frame 900 (4.5 s, window end 4.505 s): the timeline is still 4 s, the used range [0, 4.505).
    const f = await seed([{ registered: 3, claimed: 3 }, { registered: 2.5, claimed: 2.5 }], { anchorFrame: 900 });
    speak(f, [[0, 0, 0], [1, 1, 1.5]]); await control(f);
    lipSync.models[0]!.max_duration_seconds = 4.25;
    expect((await plan(await control(f))).timeline.duration).toBe(4);
    lipSync.tracking.max_duration_seconds = 4.25;
    await refused(f);
    expect(lip.lipsyncUsedSourceRange!({ duration: 4, videoDuration: V, syncMode: "cut_off" }, [{ time: 4.5, windowEnd: 901 / 200 }])).toEqual({ start: 0, end: 901 / 200 });
  });

  it("LA07 admits exactly two referenced people out of three detected and refuses a third", async () => {
    const f = await seed([{ registered: 1, claimed: 1 }, { registered: 1, claimed: 1 }, { registered: 1, claimed: 1 }], { people: 3 });
    speak(f, [[0, 0, 0], [1, 1, 1]]); await control(f);
    speak(f, [[0, 0, 0], [1, 1, 1], [2, 2, 2]]);
    await refused(f);
  });

  it("LA08 admits exactly eight dialogue rows and refuses a ninth", async () => {
    const f = await seed(Array.from({ length: 9 }, () => ({ registered: 0.5, claimed: 0.5 })));
    const rows = Array.from({ length: 9 }, (_, index): [number, number, number] => [index % 2, index, index * 0.5]);
    speak(f, rows.slice(0, 8)); await control(f);
    speak(f, rows);
    await refused(f);
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
});
