// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real analysis admission, BullMQ execution, registration, completion and settlement.
 * Only Cloudflare computation and object delivery are controlled over loopback HTTP.
 * Source registration is a SQL fixture, not evidence of an R2 upload or media decode.
 * The finite acceptance oracle was independently reviewed for inner#1306.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { Queue, QueueEvents, Worker, type ConnectionOptions } from "bullmq";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import {
  createRedisClient, getMiniToolsConfig, getNodeTaskConfig, getRedis, getStorageAdapter,
  getStreamRedis, getWorkerConfig, initCore, jitterBackoffStrategy, loadLocales, revokeSession, sessionCookieName, setSession,
  taskEventsStreamKey, type Redis,
} from "@breatic/core";
import {
  miniToolConsumptionRecordSchema, nodeHistoryService,
  nodeTaskService, runMiniToolSettlement, taskRepo, upstreamStepRepo,
} from "@breatic/domain";
import {
  canvasSpaceDocName, miniToolPlanJobRequestSchema, untilDeadline,
  type MiniToolPlanJobReport, type MiniToolPlanJobRequest,
} from "@breatic/shared";
import {
  MINI_TOOL_ANALYSIS_JOB, miniToolAnalysisRecordSchema,
  type MiniToolAnalysisRecord, type MiniToolAnalysisRequest,
} from "@breatic/shared/mini-tools";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource } from "@server/__tests__/integration/presentation-fixtures.js";
import type { createApp } from "@server/app.js";
import { candidateCropRecipeOf } from "@worker/handlers/video-presentation-recipes.js";
import type { TasksJobData } from "@worker/handlers/dispatch.js";
import type { lookupMiniToolConsumption } from "@worker/handlers/mini-tool/lookup-consumption.js";
import type { GroupConsumer } from "@collab/services/stream-group-consumer.js";

type Scenario = "empty" | "people" | "scene";
type Step = Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number];
type AnchorConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
interface ObjectBytes { bytes: Buffer; contentType: string; width: number | null; height: number | null }
interface ExternalJob { request: MiniToolPlanJobRequest; report: MiniToolPlanJobReport; running: boolean }
interface Pickup { taskId: string; name: string; tokenPresent: boolean }
interface Fixture extends StudioFixture {
  taskId: string;
  spaceId: string;
  hostNodeId: string;
  sourceAssetId: string;
  sourceKey: string;
  sourceURL: string;
  sourceHash: string;
  lotId: string;
  token: string;
  scenario: Scenario;
  delayed: boolean;
  /** Whether the first job, too, runs until released. */
  holdInitial: boolean;
  release: boolean;
  body: MiniToolAnalysisRequest;
  anchor: AnchorConnection;
  hostBefore: Record<string, unknown>;
  historyBefore: Record<string, unknown>[];
  sourceBefore: Record<string, unknown>;
  accepted: MiniToolAnalysisRecord | null;
  ledger: Record<string, unknown>;
}
interface TaskSnapshot {
  status: string;
  result: Record<string, unknown>;
  billed_at: string | null;
  billed_credits: number | null;
  created_at: string;
  completed_at: string | null;
}

const SECRET = "integration-suite-ingest-secret";
const PREFIX = "analysis-it-" + randomUUID();
const fixtureBySource = new Map<string, Fixture>();
const fixtures: Fixture[] = [];
const objects = new Map<string, ObjectBytes>();
// S6e E4-12 (inner#1306 §90): the selected presentation of each source, answered by the loopback ingest route.
const presentations = new Map<string, unknown>();
const externalJobs = new Map<string, ExternalJob>();
const submitted: MiniToolPlanJobRequest[] = [];
const objectReads = new Map<string, number>();
const reportReads = new Map<string, number>();
const pickups: Pickup[] = [];
// When each pickup of a task started, in epoch ms.
const pickupTimes = new Map<string, number[]>();
const delayedJobs = new Set<string>();
const completedJobs = new Set<string>();
const errors: unknown[] = [];
const cleanupErrors: unknown[] = [];
const thumbnails = new Map<number, ObjectBytes>();
const candidates = [
  { detectionIndex: 0, faceBox: { x: 0.1, y: 0.1, width: 0.0125, height: 0.015 }, pixelCrop: { x: 40, y: 20, width: 5, height: 3 } },
  { detectionIndex: 2, faceBox: { x: 0.5, y: 0.2, width: 0.0025, height: 0.005 }, pixelCrop: { x: 200, y: 40, width: 1, height: 1 } },
  { detectionIndex: 5, faceBox: { x: 0.7, y: 0.5, width: 0.0075, height: 0.015 }, pixelCrop: { x: 280, y: 100, width: 3, height: 3 } },
];
// §93 D5-8 (design §7.17 scene_cuts row 「切点按呈现序号记录」): the container reports cuts by presentation ordinal over the scanned
// range [1.25, 2.5) (frames 250–499, from keyframe 250); the result shows ordinal 300 at 300/200 s.
const SCENE_RANGE = { start: 1.25, end: 2.5 };
const cuts = [{ frameIndex: 300, pts: 1.5, detectionScore: 85 }];
// §93 D5 (design §7.17 people anchor row): the worker builds the recipes from the frozen full ledger, so the anchor is a
// presented frame of it: ordinal 250 at 250/200 s, a source keyframe of the 1011-frame 960x540 removal plan
// (server presentation-fixtures.ts: keyframes 0, 250, 500, 750, 1000). The display people JSON is on that 960x540 frame.
const ANCHOR = { frameIndex: 250, pts: 1.25 };
let sql: ReturnType<typeof postgres>;
let http: ReturnType<typeof createServer>;
let origin: string;
// Registered objects have https URLs, as the presentation snapshot contract requires (`httpsUrl`); the global fetch is
// wrapped so a request to this base is answered by the loopback object route instead of the network.
const PUBLIC_BASE = "https://assets.analysis-task.test/objects";
const networkFetch = globalThis.fetch;
let app: ReturnType<typeof createApp>;
let server: Server;
let consumer: GroupConsumer;
let coordination: Redis;
let queue: Queue<TasksJobData>;
let events: QueueEvents;
let worker: Worker<TasksJobData>;
let lookup: typeof lookupMiniToolConsumption;
let ownsQueue = false;

/**
 * Hash complete immutable external bytes, never a URL or node claim.
 * @returns Their lowercase SHA256.
 * @throws {Error} If hashing fails.
 */
function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Select an unused logical DB on the same injected testcontainers Redis instance.
 * @returns A test-only connection URL.
 * @throws {Error} If the injected URL is malformed.
 */
function redisURL(database: number): string {
  const value = new URL(inject("REDIS_QUEUE_URL"));
  value.pathname = "/" + database;
  return value.toString();
}

/**
 * Preserve the existing BullMQ connection options without a production queue rename.
 * @returns The isolated queue connection.
 * @throws {Error} If the injected URL is malformed.
 */
function queueConnection(): ConnectionOptions {
  const value = new URL(redisURL(4));
  return {
    host: value.hostname, port: Number(value.port), db: 4,
    maxRetriesPerRequest: null, enableReadyCheck: false,
  };
}

/**
 * Wait for an actual boundary observation, surfacing background failures immediately.
 * @returns Nothing once the supplied observation holds.
 * @throws {Error} On an infrastructure failure or bounded wait expiry.
 */
async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (errors.length !== 0) throw new AggregateError(errors, label);
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for " + label);
}

/**
 * Encode an owned external JSON artifact exactly once.
 * @returns Complete bytes and their independently supplied media metadata.
 * @throws {Error} If JSON encoding fails.
 */
function jsonObject(value: unknown): ObjectBytes {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Expected complete external JSON");
  return { bytes: Buffer.from(encoded), contentType: "text/plain", width: null, height: null };
}

/**
 * Supply only the finite Cloudflare computation outputs from the accepted oracle.
 * @returns Complete bytes of one declared output.
 * @throws {Error} For an unexpected recipe or missing fixed PNG.
 */
function outputBytes(fixture: Fixture, output: MiniToolPlanJobRequest["outputs"][number]): ObjectBytes {
  switch (output.recipe.kind) {
    case "people":
      return jsonObject({
        // §93 D5-8: no anchor echo; measured in the recipe target's 960x540.
        schemaVersion: 1, kind: "people", coordinateSpace: "display", width: 960, height: 540,
        candidates: fixture.scenario === "empty" ? [] : candidates,
      });
    case "scene_cuts":
      return jsonObject({ schemaVersion: 1, kind: "scene_cuts", cuts: [{ ordinal: 300, detectionScore: 85 }] });
    case "frame": {
      const image = thumbnails.get(output.outputIndex);
      if (image === undefined) throw new Error("Unexpected thumbnail output index");
      return image;
    }
    default: throw new Error("Unexpected analysis recipe: " + output.recipe.kind);
  }
}

/**
 * Accept an external job without mocking any local grant, step or registry owner.
 * @returns The immutable first report, or its existing asynchronous running marker.
 * @throws {Error} For an unowned source or changed external request.
 */
function acceptExternal(request: MiniToolPlanJobRequest): MiniToolPlanJobReport {
  const previous = externalJobs.get(request.jobId);
  if (previous !== undefined) {
    expect(request).toEqual(previous.request);
    return previous.running ? { schemaVersion: 2, state: "running" } : previous.report;
  }
  const fixture = fixtureBySource.get(request.inputs[0]!.inputId);
  if (fixture === undefined) throw new Error("Cloudflare boundary received an unowned source");
  submitted.push(request);
  const outputs = request.outputs.map((output) => {
    const object = outputBytes(fixture, output);
    objects.set(output.storageKey, object);
    return {
      outputIndex: output.outputIndex, storageKey: output.storageKey,
      sha256: sha(object.bytes), sizeBytes: object.bytes.length, contentType: object.contentType,
      width: object.width, height: object.height, durationSeconds: null, cover: null, upright: null,
    };
  });
  const report: MiniToolPlanJobReport = {
    schemaVersion: 2, state: "done", outputs,
    usage: { wallMs: 2000, cpuUsec: 1_000_000 },
  };
  const running = fixture.holdInitial || (fixture.delayed && request.outputs.every((output) => output.recipe.kind === "frame"));
  externalJobs.set(request.jobId, { request, report, running });
  return running ? { schemaVersion: 2, state: "running" } : report;
}

/**
 * Deliver actual loopback HTTP for Cloudflare reports and registered object reads.
 * @returns Nothing after sending the complete response.
 * @throws {Error} For unexpected traffic, identity or request content.
 */
async function respondHTTP(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", origin).pathname;
  if (path.startsWith("/objects/") && request.method === "GET") {
    const key = decodeURIComponent(path.slice("/objects/".length));
    const object = objects.get(key);
    if (object === undefined) throw new Error("Unregistered object read: " + key);
    objectReads.set(key, (objectReads.get(key) ?? 0) + 1);
    response.writeHead(200, { "content-type": object.contentType, "content-length": object.bytes.length });
    response.end(object.bytes);
    return;
  }
  expect(request.headers["x-ingest-secret"]).toBe(SECRET);
  if (path === "/video-presentation" && request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { action: string; storageKey: string };
    const snapshot = presentations.get(body.storageKey);
    if (body.action !== "read" || snapshot === undefined) throw new Error("Unexpected presentation request: " + body.action + " " + body.storageKey);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(snapshot));
    return;
  }
  let answer: MiniToolPlanJobReport;
  if (path === "/jobs" && request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    answer = acceptExternal(miniToolPlanJobRequestSchema.parse(body));
  } else if (path.startsWith("/jobs/") && request.method === "GET") {
    const [, , containerClass, encodedJob] = path.split("/");
    const jobId = decodeURIComponent(encodedJob ?? "");
    const job = externalJobs.get(jobId);
    reportReads.set(jobId, (reportReads.get(jobId) ?? 0) + 1);
    if (job === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    expect(decodeURIComponent(containerClass ?? "")).toBe(job.request.containerClass);
    const fixture = fixtureBySource.get(job.request.inputs[0]!.inputId)!;
    if (job.running && fixture.release) job.running = false;
    answer = job.running ? { schemaVersion: 2, state: "running" } : job.report;
  } else throw new Error("Unexpected HTTP boundary: " + request.method + " " + path);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(answer));
}

/**
 * Read one actual host map through the same Hocuspocus connection used by Collab.
 * @returns The node's complete data, position and document node count.
 * @throws {Error} When the seeded host has disappeared.
 */
async function hostSnapshot(fixture: Fixture): Promise<Record<string, unknown>> {
  let snapshot: Record<string, unknown> = {};
  await fixture.anchor.transact((doc: Y.Doc) => {
    const nodes = doc.getMap("nodesMap");
    const node = nodes.get(fixture.hostNodeId);
    if (!(node instanceof Y.Map)) throw new Error("Original host disappeared");
    const data = node.get("data");
    if (!(data instanceof Y.Map)) throw new Error("Original host data disappeared");
    snapshot = { data: data.toJSON(), position: node.get("position"), nodeCount: nodes.size };
  });
  return snapshot;
}

/**
 * Read the complete original task without rounding its SQL acceptance timestamp.
 * @returns Current computation, result and billing facts.
 * @throws {Error} When the accepted task is missing or SQL fails.
 */
async function taskSnapshot(fixture: Fixture): Promise<TaskSnapshot> {
  const [row] = await sql<TaskSnapshot[]>`SELECT status,result,billed_at::text,billed_credits,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    completed_at::text FROM tasks WHERE id=${fixture.taskId}`;
  if (row === undefined) throw new Error("Original analysis task disappeared");
  return row;
}

/**
 * Read original history rows in deterministic identity order.
 * @returns The host's exact persistent history.
 * @throws {Error} When SQL fails.
 */
async function historySnapshot(fixture: Pick<Fixture, "projectId" | "hostNodeId">): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`SELECT * FROM node_history
    WHERE project_id=${fixture.projectId} AND node_id=${fixture.hostNodeId} ORDER BY id`;
}

/**
 * Seed a real existing source registration and ordinary authenticated host.
 * @returns Inputs whose task, grants and result will all be created by production owners.
 * @throws {Error} When database, sessions or collaboration setup fails.
 */
async function seed(scenario: Scenario, delayed = false): Promise<Fixture> {
  const base = await seedStudioFixture(sql, "analysis-task");
  await sql`INSERT INTO project_members(project_id,user_id,role)
    VALUES(${base.projectId},${base.userId},'owner')`;
  const lotId = await seedDesignatedLot(sql, base, 1000);
  const sourceAssetId = randomUUID();
  const sourceKey = "video/analysis-task/" + sourceAssetId + ".mp4";
  const storage = await getStorageAdapter();
  const sourceURL = storage.publicUrl(sourceKey);
  const sourceHash = randomBytes(32).toString("hex");
  await sql`INSERT INTO studio_assets(id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,
    source,produced_by_user_id,width,height,duration_seconds)
    VALUES(${sourceAssetId},${base.studioId},${sourceHash},${sourceKey},${sourceURL},4096,
      'video/mp4','video','upload',${base.userId},400,200,36)`;
  // The analysis names the selected version's tool input; its ledger objects are served like any registered object.
  const presentation = await presentedSource(sourceHash, sourceKey, (key) => storage.publicUrl(key));
  presentations.set(sourceKey, presentation.snapshot);
  for (const [url, body] of presentation.bodies) {
    objects.set(url.slice(storage.publicUrl("").length), { bytes: Buffer.from(body), contentType: "application/json", width: null, height: null });
  }
  const taskId = randomUUID();
  const spaceId = randomUUID();
  const hostNodeId = randomUUID();
  const token = randomBytes(24).toString("hex");
  await setSession(getRedis(), token, base.userId);
  const connection = await server.hocuspocus.openDirectConnection(canvasSpaceDocName(base.projectId, spaceId), {
    context: { user: { id: base.userId }, source: "analysis-task-fixture" },
  });
  const data = {
    content: sourceURL, coverUrl: origin + "/original-cover.png",
    width: 400, height: 200, duration: 36, mimeType: "video/mp4", size: 4096,
    originalExtension: { preserved: true },
    taskCounts: { running: 0, done: 0, failed: 0, expired: 0 },
  };
  await connection.transact((doc: Y.Doc) => {
    doc.getMap("nodesMap").set(hostNodeId, new Y.Map<unknown>([
      ["id", hostNodeId], ["type", "video"], ["position", { x: 100, y: 200 }],
      ["data", new Y.Map(Object.entries(data))],
    ]));
  });
  await nodeHistoryService.recordUpload({
    projectId: base.projectId, nodeId: hostNodeId, userId: base.userId,
    content: sourceURL, storageKey: sourceKey,
    media: { width: 400, height: 200, duration: 36, mimeType: "video/mp4", size: 4096 },
  });
  const identity = {
    analysisRunId: taskId, projectId: base.projectId, spaceId, hostNodeId,
    draftId: randomUUID(), revision: randomUUID(),
    source: { nodeId: hostNodeId, canonicalURL: sourceURL,
      mediaInfo: { width: 400, height: 200, duration: 36, mimeType: "video/mp4" } },
    presentationRef: presentation.presentationRef,
  };
  const body: MiniToolAnalysisRequest = scenario === "scene"
    ? { ...identity, kind: "scene_cuts", params: { range: SCENE_RANGE } }
    : { ...identity, kind: "people", params: { anchor: ANCHOR } };
  const [sourceBefore] = await sql<Record<string, unknown>[]>`SELECT * FROM studio_assets WHERE id=${sourceAssetId}`;
  const fixture: Fixture = {
    ...base, taskId, spaceId, hostNodeId, sourceAssetId, sourceKey, sourceURL, sourceHash,
    lotId, token, scenario, delayed, holdInitial: false, release: false, body, anchor: connection,
    hostBefore: {}, historyBefore: [], sourceBefore: sourceBefore!, accepted: null, ledger: presentation.full,
  };
  fixtures.push(fixture);
  fixtureBySource.set(sourceAssetId, fixture);
  fixture.hostBefore = await hostSnapshot(fixture);
  fixture.historyBefore = await historySnapshot(fixture);
  return fixture;
}

/**
 * Exercise real authentication, admission, row/hold creation and queue submission.
 * @returns The actual accepted record.
 * @throws {Error} When the real API refuses or returns an invalid record.
 */
async function admit(fixture: Fixture, key = randomUUID()): Promise<MiniToolAnalysisRecord> {
  const response = await app.request("/api/v1/mini-tools/analyses", {
    method: "POST", headers: {
      "content-type": "application/json", "Idempotency-Key": key,
      cookie: sessionCookieName() + "=" + fixture.token,
    }, body: JSON.stringify(fixture.body),
  });
  const body = await response.json() as { data?: unknown };
  expect({ status: response.status, error: body.data === undefined ? body : null }).toEqual({ status: 201, error: null });
  return miniToolAnalysisRecordSchema.parse(body.data);
}

/**
 * Read the current result through the original authorization and API mapping.
 * @returns The current public record.
 * @throws {Error} When the real API fails.
 */
async function getRecord(fixture: Fixture): Promise<MiniToolAnalysisRecord> {
  const response = await app.request("/api/v1/mini-tools/analyses/" + fixture.taskId, {
    headers: { cookie: sessionCookieName() + "=" + fixture.token },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: unknown };
  return miniToolAnalysisRecordSchema.parse(body.data);
}

/**
 * Complete the real queue pickup and read the independently published host counts.
 * @returns Its successful public result.
 * @throws {Error} On a queue, SQL or host propagation failure.
 */
async function execute(fixture: Fixture): Promise<MiniToolAnalysisRecord> {
  await worker.pause();
  fixture.accepted = await admit(fixture);
  expect(fixture.accepted).toMatchObject({ analysisRunId: fixture.taskId, status: "pending", result: null });
  const job = await queue.getJob(fixture.taskId);
  expect(job?.name).toBe(MINI_TOOL_ANALYSIS_JOB);
  expect(job?.data).toMatchObject({
    taskId: fixture.taskId, userId: fixture.userId, projectId: fixture.projectId,
    spaceId: fixture.spaceId, hostNodeId: fixture.hostNodeId, source: "mini_tool", sourceKey: fixture.sourceKey,
  });
  const deadline = await nodeTaskService.deadlineFor(fixture.taskId);
  const [node] = await sql<{ budget_ms: number; status: string }[]>`SELECT budget_ms,status
    FROM node_tasks WHERE task_id=${fixture.taskId} AND node_id=${fixture.hostNodeId}`;
  expect(node).toEqual({ budget_ms: getNodeTaskConfig().default_budget_ms, status: "running" });
  await worker.resume();
  if (fixture.delayed) {
    await waitUntil(async () => delayedJobs.has(fixture.taskId), "the actual delayed analysis pickup");
    const steps = await upstreamStepRepo.listSteps(fixture.taskId);
    expect(steps).toHaveLength(2);
    const initial = miniToolPlanJobRequestSchema.parse(steps[0]!.output.miniToolPlanJob);
    expect(steps[0]!.output).toHaveProperty("miniToolAnalysisJson:0");
    expect(objectReads.get(initial.outputs[0]!.storageKey)).toBe(1);
    expect((await taskSnapshot(fixture)).status).toBe("running");
    fixture.release = true;
  }
  await waitUntil(async () => completedJobs.has(fixture.taskId), "the actual completed BullMQ job");
  await waitUntil(async () => {
    const host = await hostSnapshot(fixture);
    const counts = (host.data as Record<string, unknown>).taskCounts as Record<string, number>;
    return counts.running === 0 && counts.done === 1 && counts.failed === 0 && counts.expired === 0;
  }, "Collab's actual host counts");
  const ownPlans = submitted.filter((request) => request.inputs[0]!.inputId === fixture.sourceAssetId);
  expect(ownPlans.map((request) => request.deadlineAt)).toEqual(ownPlans.map(() => deadline));
  expect(pickups.filter((pickup) => pickup.taskId === fixture.taskId).slice(0, fixture.delayed ? 2 : 1)).toEqual(
    Array.from({ length: fixture.delayed ? 2 : 1 }, () => ({ taskId: fixture.taskId, name: MINI_TOOL_ANALYSIS_JOB, tokenPresent: true })),
  );
  return getRecord(fixture);
}

/**
 * Check accepted identity, unchanged canonical content, persistent history and pending costs.
 * @returns The actual registered steps.
 * @throws {Error} On an infrastructure or invariant failure.
 */
async function assertCompleted(fixture: Fixture, record: MiniToolAnalysisRecord, stepCount: number, outputCount: number): Promise<Step[]> {
  const task = await taskSnapshot(fixture);
  expect(task.status).toBe("completed");
  expect(task.created_at).toBe(fixture.accepted!.acceptedAt);
  expect(typeof task.completed_at).toBe("string");
  expect({ billed_at: task.billed_at, billed_credits: task.billed_credits }).toEqual({ billed_at: null, billed_credits: null });
  expect(record).toMatchObject({
    ...fixture.accepted!, status: "completed", result: expect.any(Object), error: null, artifactUnavailable: false,
  });
  expect(record.result).toMatchObject({
    schemaVersion: 1, draftId: record.draftId, revision: record.revision, analysisRunId: fixture.taskId,
    acceptedAt: fixture.accepted!.acceptedAt, binding: fixture.accepted!.binding,
    analysisInput: fixture.accepted!.analysisInput, inputFingerprint: fixture.accepted!.inputFingerprint,
  });
  const steps = await upstreamStepRepo.listSteps(fixture.taskId);
  expect(steps).toHaveLength(stepCount);
  expect(submitted.filter((request) => request.inputs[0]!.inputId === fixture.sourceAssetId)).toHaveLength(stepCount);
  const facts = steps.map((step) => miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption));
  expect(facts.map((fact) => ({ state: fact.state, chargeTo: fact.chargeTo, costUsd: fact.costUsd, credits: fact.credits }))).toEqual(
    facts.map(() => ({ state: "pending", chargeTo: fixture.scenario === "scene" ? "user" : "platform", costUsd: null, credits: null })),
  );
  expect(task.result.settlement).toMatchObject({ consumptionSetComplete: true });
  const grants = await sql<{ consumed: boolean; asset_id: string; generation_task_id: string }[]>`
    SELECT consumed_at IS NOT NULL AS consumed,asset_id,generation_task_id FROM upload_grants WHERE generation_task_id=${fixture.taskId}`;
  expect(grants).toHaveLength(outputCount);
  expect(grants.map((grant) => ({ consumed: grant.consumed, generation_task_id: grant.generation_task_id }))).toEqual(
    grants.map(() => ({ consumed: true, generation_task_id: fixture.taskId })),
  );
  const [usage] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE project_id=${fixture.projectId}`;
  expect(usage).toEqual({ count: 0 });
  const host = await hostSnapshot(fixture);
  const before = fixture.hostBefore.data as Record<string, unknown>;
  expect(host).toEqual({ ...fixture.hostBefore, data: { ...before, taskCounts: { running: 0, done: 1, failed: 0, expired: 0 } } });
  expect(await historySnapshot(fixture)).toEqual(fixture.historyBefore);
  const [source] = await sql<Record<string, unknown>[]>`SELECT * FROM studio_assets WHERE id=${fixture.sourceAssetId}`;
  expect(source).toEqual(fixture.sourceBefore);
  const [node] = await sql<{ status: string; node_history_id: string | null }[]>`
    SELECT status,node_history_id FROM node_tasks WHERE task_id=${fixture.taskId} AND node_id=${fixture.hostNodeId}`;
  expect(node).toEqual({ status: "done", node_history_id: null });
  return steps;
}

/**
 * Advance only the existing settlement owner against the same immutable HTTP reports.
 * @returns Nothing once actual usage, the parent charge and holds are closed.
 * @throws {Error} On a lookup, transaction or invariant failure.
 */
async function settle(fixture: Fixture, count: number): Promise<void> {
  const beforeReads = new Map(submitted.filter((request) => request.inputs[0]!.inputId === fixture.sourceAssetId)
    .map((request) => [request.jobId, reportReads.get(request.jobId) ?? 0]));
  const holds = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${fixture.taskId}`;
  expect(holds).toEqual(fixture.scenario === "scene" ? [{ status: "held" }] : []);
  await waitUntil(async () => {
    const wake = await taskRepo.waitingMiniToolSettlement(fixture.taskId);
    if (wake !== null) {
      const result = await runMiniToolSettlement({ taskId: wake.taskId, settlementVersion: wake.settlementVersion }, (input) => lookup(input,
        untilDeadline(Date.now() + getMiniToolsConfig().settlement.lookup_timeout_ms)));
      if (result.failure !== undefined) throw result.failure;
    }
    return (await taskSnapshot(fixture)).billed_at !== null;
  }, "actual parent consumption settlement");
  const task = await taskSnapshot(fixture);
  expect(task.billed_credits).toBe(fixture.scenario === "scene" ? 0.03 : 0);
  expect(task.result.settlement).toMatchObject({ state: "settled", consumptionSetComplete: true, pendingConsumptionKeys: [] });
  const steps = await upstreamStepRepo.listSteps(fixture.taskId);
  const facts = steps.map((step) => miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption));
  for (const [jobId, reads] of beforeReads) expect(reportReads.get(jobId)).toBe(reads + 1);
  expect(facts.map((fact) => ({ state: fact.state, costUsd: fact.costUsd, costSource: fact.costSource, credits: fact.credits }))).toEqual(
    Array.from({ length: count }, () => ({ state: "recorded", costUsd: 0.00004112, costSource: "computed", credits: fixture.scenario === "scene" ? 0.028784 : 0 })),
  );
  for (const fact of facts) expect(fact.raw).toMatchObject({ usage: { wallMs: 2000, cpuUsec: 1_000_000 } });
  const usage = await sql<{ operation_key: string; feature: string; source: string; provider: string; model: string; actor_user_id: string; project_id: string; cost_source: string; cost_usd: string; credits: string }[]>`
    SELECT operation_key,feature,source,provider,model,actor_user_id,project_id,cost_source,cost_usd::text,credits::text
    FROM agent_usage_records WHERE project_id=${fixture.projectId} ORDER BY operation_key`;
  expect(usage).toEqual(facts.map((fact) => ({
    operation_key: fact.consumptionKey, feature: "mini_tool", source: "container", provider: "cloudflare",
    model: "cloudflare-container:MiniToolContainerStd1", actor_user_id: fixture.userId, project_id: fixture.projectId,
    cost_source: "computed", cost_usd: "0.00004112", credits: fixture.scenario === "scene" ? "0.028784" : "0.000000",
  })).sort((left, right) => left.operation_key.localeCompare(right.operation_key)));
  const [lot] = await sql<{ remaining: string }[]>`SELECT remaining_credits::text AS remaining FROM credit_lots WHERE id=${fixture.lotId}`;
  expect(Number(lot!.remaining)).toBe(fixture.scenario === "scene" ? 999.97 : 1000);
  const endedHolds = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${fixture.taskId}`;
  expect(endedHolds).toEqual(fixture.scenario === "scene" ? [{ status: "released" }] : []);
  const ledger = await sql<{ amount: string }[]>`SELECT amount::text FROM credit_ledger WHERE reference_id=${fixture.taskId}`;
  expect(ledger.map((entry) => Math.abs(Number(entry.amount)))).toEqual(fixture.scenario === "scene" ? [0.03] : []);
}

/**
 * Observe actual registration winners instead of deriving asset IDs or URLs from keys.
 * @returns The precise public people items bound to the original candidate indices.
 * @throws {Error} When a cached registration row is missing.
 */
async function expectedPeople(fixture: Fixture, steps: Step[]): Promise<unknown[]> {
  if (fixture.scenario === "empty") return [];
  const result: unknown[] = [];
  for (const candidate of candidates) {
    const id = steps[1]!.output["miniToolAsset:" + candidate.detectionIndex];
    const [asset] = await sql<{ id: string; file_url: string; content_hash: string; mime_type: string; size_bytes: string; width: number; height: number }[]>`
      SELECT id,file_url,content_hash,mime_type,size_bytes::text,width,height FROM studio_assets WHERE id=${String(id)}`;
    if (asset === undefined) throw new Error("Canonical thumbnail registration is missing");
    const image = thumbnails.get(candidate.detectionIndex)!;
    expect({ hash: asset.content_hash, size: Number(asset.size_bytes), width: asset.width, height: asset.height }).toEqual({
      hash: sha(image.bytes), size: image.bytes.length, width: image.width, height: image.height,
    });
    result.push({ personId: "person:" + fixture.taskId + ":" + candidate.detectionIndex, faceBox: candidate.faceBox,
      artifactRefs: [{ role: "thumbnail", assetId: asset.id, canonicalURL: asset.file_url, contentHash: asset.content_hash,
        kind: "image", mimeType: asset.mime_type, size: Number(asset.size_bytes), frameMetadata: null }] });
  }
  return result;
}

/**
 * Record immutable object/plan/expense facts to prove replay does not recompute.
 * @returns A stable snapshot of this original task's persistent and external identities.
 * @throws {Error} When SQL fails.
 */
async function replaySnapshot(fixture: Fixture): Promise<unknown> {
  return {
    task: await taskSnapshot(fixture), steps: await upstreamStepRepo.listSteps(fixture.taskId),
    plans: submitted.filter((request) => request.inputs[0]!.inputId === fixture.sourceAssetId),
    grants: await sql`SELECT * FROM upload_grants WHERE generation_task_id=${fixture.taskId} ORDER BY id`,
    usage: await sql`SELECT * FROM agent_usage_records WHERE project_id=${fixture.projectId} ORDER BY id`,
    ledger: await sql`SELECT * FROM credit_ledger WHERE reference_id=${fixture.taskId} ORDER BY id`,
    history: await historySnapshot(fixture),
  };
}

/**
 * Finish all owned teardown steps even when one fixture cleanup fails.
 * @returns Nothing after capturing any cleanup error.
 * @throws {never} Errors are collected for the final teardown assertion.
 */
async function cleanup(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    cleanupErrors.push(error);
  }
}

beforeAll(async () => {
  http = createServer((request, response) => {
    void respondHTTP(request, response).catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Unexpected analysis boundary");
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (http.address() as AddressInfo).port;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(PUBLIC_BASE + "/")) return networkFetch(input, init);
    return networkFetch(origin + "/objects/" + url.slice(PUBLIC_BASE.length + 1), input instanceof Request ? { method: input.method, headers: input.headers, signal: input.signal, ...init } : init);
  };
  initCore({
    ...process.env, DATABASE_URL: inject("DATABASE_URL"), YJS_DATABASE_URL: inject("YJS_DATABASE_URL"),
    REDIS_QUEUE_URL: redisURL(4), REDIS_STREAM_URL: redisURL(5), REDIS_COLLAB_URL: redisURL(6), REDIS_URL: redisURL(7),
    REDIS_KEY_PREFIX: PREFIX, INGEST_BASE_URL: origin, UPLOAD_BASE_URL: PUBLIC_BASE,
    INGEST_SHARED_SECRET: SECRET, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "7",
    STRIPE_SECRET_KEY: "sk_test_unused_by_analysis_task", STRIPE_WEBHOOK_SECRET: "whsec_unused_by_analysis_task",
    WAVESPEED_API_KEY: "unused-by-analysis-task",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: PREFIX } });
  for (const [index, file, width, height] of [
    [0, "q4-odd-origin-5x3.png", 5, 3], [2, "q7-subpixel-selection-1x1.png", 1, 1], [5, "q9-right-bottom-3x3.png", 3, 3],
  ] as const) {
    thumbnails.set(index, { bytes: await readFile(new URL("../../../ingest/container/__tests__/fixtures/people-crop/expected/" + file, import.meta.url)),
      contentType: "image/png", width, height });
  }
  const { createApp } = await import("@server/app.js");
  app = createApp();
  const { runTask } = await import("@worker/handlers/dispatch.js");
  lookup = (await import("@worker/handlers/mini-tool/lookup-consumption.js")).lookupMiniToolConsumption;
  server = new Server({ port: 0, quiet: true, extensions: [] });
  await server.listen();
  coordination = createRedisClient(redisURL(6), { name: PREFIX });
  const { startTaskListener } = await import("@collab/services/task-listener.js");
  consumer = startTaskListener({
    hocuspocus: server.hocuspocus, streamUrl: redisURL(5), streamKey: taskEventsStreamKey(),
    legacyCursorKey: PREFIX + ":cursor", keyPrefix: PREFIX, instanceId: PREFIX, coordination,
    settings: { maxHeld: 128, blockMs: 100, leaseRetryMs: 50, claimIntervalMs: 15_000, claimIdleMs: 60_000,
      retryMinMs: 50, retryMaxMs: 200, maxFailures: 3, stopDeadlineMs: 2000,
      forgetIdleConsumerMs: 86_400_000, keyConcurrency: 4, docLeaseMs: 30_000, handoffPollMs: 20, handoffWaitMs: 200 },
  });
  queue = new Queue<TasksJobData>("tasks", { connection: queueConnection() });
  expect(await Promise.all([queue.getWaitingCount(), queue.getActiveCount(), queue.getDelayedCount(),
    queue.getCompletedCount(), queue.getFailedCount()])).toEqual([0, 0, 0, 0, 0]);
  ownsQueue = true;
  events = new QueueEvents("tasks", { connection: queueConnection() });
  events.on("delayed", ({ jobId }) => delayedJobs.add(jobId));
  events.on("completed", ({ jobId }) => completedJobs.add(jobId));
  const { reclaimFailedJobById } = await import("@worker/handlers/failed-job-cleanup.js");
  events.on("failed", ({ jobId, failedReason }) => {
    void reclaimFailedJobById(queue, getStreamRedis(), jobId, failedReason).catch((error: unknown) => errors.push(error));
  });
  worker = new Worker<TasksJobData>("tasks", async (job, token) => {
    pickups.push({ taskId: job.data.taskId, name: job.name, tokenPresent: typeof token === "string" });
    pickupTimes.set(job.data.taskId, [...pickupTimes.get(job.data.taskId) ?? [], Date.now()]);
    return runTask(job, token);
  }, { connection: queueConnection(), concurrency: 1, lockDuration: getWorkerConfig().lock_duration_ms,
    settings: { backoffStrategy: jitterBackoffStrategy(getWorkerConfig().job_backoff_delay_ms) } });
  worker.on("error", (error) => errors.push(error));
  await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
  await worker.pause();
});

afterAll(async () => {
  globalThis.fetch = networkFetch;
  if (worker) await cleanup(() => worker.close(true));
  if (events) await cleanup(() => events.close());
  if (consumer) await cleanup(() => consumer.stop());
  for (const fixture of fixtures) {
    await cleanup(() => fixture.anchor.disconnect());
    await cleanup(() => revokeSession(getRedis(), fixture.token));
  }
  if (server) await cleanup(() => server.destroy());
  if (consumer) await cleanup(() => getStreamRedis().del(taskEventsStreamKey()));
  if (coordination) await cleanup(async () => {
    let cursor = "0";
    do {
      const [next, keys] = await coordination.scan(cursor, "MATCH", PREFIX + "*", "COUNT", 100);
      cursor = next;
      if (keys.length !== 0) await coordination.del(...keys);
    } while (cursor !== "0");
  });
  if (coordination) await cleanup(() => coordination.quit());
  if (queue) {
    if (ownsQueue) await cleanup(() => queue.obliterate({ force: true }));
    await cleanup(() => queue.close());
  }
  // Rows are confined to the existing disposable, globalSetup-owned PG fixture.
  // Delete only this file's execution artifacts; shared infrastructure owns DB teardown.
  if (sql) {
    for (const fixture of fixtures) await cleanup(() => sql.begin(async (tx) => {
      await tx`DELETE FROM node_tasks WHERE task_id=${fixture.taskId}`;
      await tx`DELETE FROM node_history WHERE project_id=${fixture.projectId}`;
      await tx`DELETE FROM upload_grants WHERE project_id=${fixture.projectId}`;
      // Registered thumbnails are referenced by the project (migration 0109); their references go first.
      await tx`DELETE FROM project_asset_refs WHERE project_id=${fixture.projectId}`;
      await tx`DELETE FROM studio_assets WHERE studio_id=${fixture.studioId}`;
      await tx`DELETE FROM agent_usage_records WHERE project_id=${fixture.projectId}`;
      await tx`DELETE FROM credit_ledger WHERE reference_id=${fixture.taskId}`;
      await tx`DELETE FROM credit_holds WHERE reference_id=${fixture.taskId}`;
      await tx`DELETE FROM task_upstream_steps WHERE task_id=${fixture.taskId}`;
      await tx`DELETE FROM tasks WHERE id=${fixture.taskId}`;
    }));
    await cleanup(() => sql.end({ timeout: 1 }));
  }
  if (http) await cleanup(() => new Promise<void>((resolve, reject) => {
    http.close((error) => error ? reject(error) : resolve());
    http.closeAllConnections();
  }));
  if (cleanupErrors.length !== 0) throw new AggregateError(cleanupErrors, "Owned analysis harness cleanup failed");
});

describe("accepted analysis → real task execution → canonical registration and host counts", () => {
  it("completes an empty people result while its measured platform expense is independently pending", async () => {
    const fixture = await seed("empty");
    const record = await execute(fixture);
    await assertCompleted(fixture, record, 1, 1);
    expect(record.result).toMatchObject({ kind: "people", anchor: ANCHOR, people: [] });
    await settle(fixture, 1);
  });

  it("registers three canonical thumbnails without replacing the original host media or history", async () => {
    const fixture = await seed("people");
    const record = await execute(fixture);
    const steps = await assertCompleted(fixture, record, 2, 4);
    expect(record.result).toMatchObject({ kind: "people", anchor: ANCHOR, people: await expectedPeople(fixture, steps) });
    const plan = miniToolPlanJobRequestSchema.parse(steps[1]!.output.miniToolPlanJob);
    // §93 D5 (design §7.17 「唯一写点：worker的配方构造」): each crop is the anchor's frame recipe on the frozen ledger's entry.
    expect(plan.outputs.map(({ outputIndex, recipe }) => ({ outputIndex, recipe }))).toEqual(candidates.map((candidate) => ({
      outputIndex: candidate.detectionIndex, recipe: candidateCropRecipeOf(fixture.ledger as unknown as Parameters<typeof candidateCropRecipeOf>[0], ANCHOR,
        fixture.sourceAssetId, { sourceWidth: 960, sourceHeight: 540, rect: candidate.pixelCrop }),
    })));
    await settle(fixture, 2);
  });

  it("maps scene cuts to the original VFR ledger and settles only the actual measured user cost", async () => {
    const fixture = await seed("scene");
    const record = await execute(fixture);
    // §93 D5 (design §7.17 「去掉inspect_video步骤」): one step with one output grant (was inspect plus scenes).
    await assertCompleted(fixture, record, 1, 1);
    // §93 D5-8: the presentation clock (1/200) and the ledger's 1011 frames; one scene_cuts output, no inspect_video.
    expect(record.result).toMatchObject({ kind: "scene_cuts", frameCount: 1011, timeBase: { numerator: 1, denominator: 200 }, cuts });
    expect(submitted.filter((request) => request.inputs[0]!.inputId === fixture.sourceAssetId).flatMap((request) => request.outputs.map((output) => output.recipe.kind))).toEqual(["scene_cuts"]);
    await settle(fixture, 1);
  });

  it("replays the same accepted run through SQL without another compute, registration, usage or charge", async () => {
    const fixture = await seed("people");
    const record = await execute(fixture);
    await assertCompleted(fixture, record, 2, 4);
    await settle(fixture, 2);
    const before = await replaySnapshot(fixture);
    expect(await admit(fixture)).toEqual(await getRecord(fixture));
    expect((await getRecord(fixture)).result).toEqual(record.result);
    const settled = await runMiniToolSettlement({ taskId: fixture.taskId, settlementVersion: 0 }, (input) =>
      lookup(input, untilDeadline(Date.now() + getMiniToolsConfig().settlement.lookup_timeout_ms)));
    expect(settled).toMatchObject({ charge: null, nextWake: null });
    expect(await replaySnapshot(fixture)).toEqual(before);
  });

  it("resumes a real delayed pickup using the original registered JSON and crop plans", async () => {
    const fixture = await seed("people", true);
    const record = await execute(fixture);
    const steps = await assertCompleted(fixture, record, 2, 4);
    expect(record.result).toMatchObject({ kind: "people", people: await expectedPeople(fixture, steps) });
    for (const step of steps) {
      const plan = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
      expect(submitted.filter((request) => request.jobId === plan.jobId)).toHaveLength(1);
    }
    const initial = miniToolPlanJobRequestSchema.parse(steps[0]!.output.miniToolPlanJob);
    expect(objectReads.get(initial.outputs[0]!.storageKey)).toBe(1);
    await settle(fixture, 2);
  });

  // User decision (same rule as runs): a pickup after the deadline still reads what already finished and hands it to the
  // user; only new work stays refused after it.
  it.each([["AT06 a scene", "scene"], ["AT07 an empty people", "empty"]] as const)(
    "%s analysis whose job reported done before the deadline completes in its first pickup after it and records its usage once", async (_name, scenario) => {
      const fixture = await seed(scenario);
      fixture.holdInitial = true;
      await worker.pause();
      fixture.accepted = await admit(fixture);
      // The task's two hours end 4 s from now: the first pickup submits before then, and the next, a poll (5 s) later, runs after.
      await sql`UPDATE node_tasks SET started_at = now() - make_interval(secs => (budget_ms - 4000) / 1000.0) WHERE task_id=${fixture.taskId}`;
      const deadline = (await nodeTaskService.deadlineFor(fixture.taskId))!;
      await worker.resume();
      await waitUntil(async () => delayedJobs.has(fixture.taskId), "the delayed pickup before the deadline");
      const plans = submitted.filter((request) => request.inputs[0]!.inputId === fixture.sourceAssetId);
      expect(plans.map((request) => request.deadlineAt)).toEqual([deadline]);
      fixture.release = true;
      await waitUntil(async () => completedJobs.has(fixture.taskId), "the completed BullMQ job", 60_000);
      const times = pickupTimes.get(fixture.taskId)!;
      expect(times[0]!).toBeLessThan(deadline);
      expect(times.slice(1).length).toBeGreaterThan(0);
      expect(times[1]!).toBeGreaterThanOrEqual(deadline);
      await waitUntil(async () => {
        const host = await hostSnapshot(fixture);
        const counts = (host.data as Record<string, unknown>).taskCounts as Record<string, number>;
        return counts.running === 0 && counts.done === 1 && counts.failed === 0 && counts.expired === 0;
      }, "Collab's actual host counts");
      const record = await getRecord(fixture);
      expect(record.error).toBeNull();
      expect(record.result).toMatchObject(scenario === "scene" ? { kind: "scene_cuts", cuts } : { kind: "people", anchor: ANCHOR, people: [] });
      await assertCompleted(fixture, record, 1, 1);
      await settle(fixture, 1);
    });
});
