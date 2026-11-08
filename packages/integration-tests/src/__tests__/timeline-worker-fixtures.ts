// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Fixtures for the Timeline execution worker suites (inner#1711 design §5.2, §5.3): a Project whose meta document
 * lists one Timeline Space, an accepted execution moved into the state a case starts from (acceptance holds no
 * credits), a stand-in for the ingest Worker's job routes, and the reports and Manifest a web-animation job produces.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import * as Y from "yjs";
import { expect, vi } from "vitest";
import { env, getStorageAdapter, initLogger, timelineExecutionRepo } from "@breatic/core";
import type { createPgClient } from "@breatic/core";
import { projectMetaDocName, spaceContentDocName, type TimelineExecution } from "@breatic/shared";
import {
  WEB_ANIMATION_CONTAINER_CLASS,
  initializeTimelineDocument,
  type WebAnimationJobCall,
  type WebAnimationJobReport,
  type WebAnimationManifest,
} from "@breatic/shared/space-content";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

type Sql = ReturnType<typeof createPgClient>;

/** The states a case may start an execution in. */
export type StartState = "awaiting_landing" | "queued" | "running" | "cancelling";

/** One accepted execution and what surrounds it. */
export interface ExecutionFixture {
  execution: TimelineExecution;
  projectId: string;
  spaceId: string;
  studioId: string;
  userId: string;
  packageKey: string;
  manifestKey: string;
}

/**
 * Store a Project's meta document listing Timeline Spaces, and each Space's content row.
 * @param projectId - The Project.
 * @param spaceIds - The Spaces it lists.
 */
export async function storeSpaces(projectId: string, spaceIds: string[]): Promise<void> {
  const meta = new Y.Doc();
  const spaces = meta.getMap("spaces");
  for (const id of spaceIds) {
    const entry = new Y.Map<unknown>();
    spaces.set(id, entry);
    entry.set("type", "timeline");
    entry.set("name", "Timeline");
    entry.set("order", 0);
    const content = new Y.Doc();
    initializeTimelineDocument(content, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
    await yjsRepo.upsertDocData(spaceContentDocName(projectId, id, "timeline"), Y.encodeStateAsUpdate(content));
    content.destroy();
  }
  await yjsRepo.upsertDocData(projectMetaDocName(projectId), Y.encodeStateAsUpdate(meta));
  meta.destroy();
}

/**
 * Remove a Space from its Project, as deleting it does: the meta list drops it and its content row is soft-deleted.
 * @param projectId - The Project.
 * @param spaceId - The Space.
 */
export async function deleteSpace(projectId: string, spaceId: string): Promise<void> {
  await yjsRepo.upsertDocData(projectMetaDocName(projectId), Y.encodeStateAsUpdate(new Y.Doc()));
  await yjsRepo.softDeleteByName(spaceContentDocName(projectId, spaceId, "timeline"));
}

/**
 * Accept an execution in a fresh Project, as acceptance does with no credit hold, and move it to the state the case
 * starts from.
 * @param sql - The suite's own connection.
 * @param state - Where the execution starts.
 * @returns The fixture.
 * @throws {Error} When a fixture write or step fails.
 */
export async function seedExecution(sql: Sql, state: StartState): Promise<ExecutionFixture> {
  const userId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${userId}, ${`tl-worker-${userId}@example.test`}, true)`;
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${userId}, ${studioId}, 'personal', 'Timeline worker')`;
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug) VALUES (${projectId}, ${studioId}, ${userId}, 'Timeline worker', ${`tw-${projectId}`})`;
  const spaceId = randomUUID();
  await storeSpaces(projectId, [spaceId]);
  const inserted = await timelineExecutionRepo.insert({
    projectId,
    spaceId,
    actorUserId: userId,
    kind: "web_animation_create",
    engine: "deepseek",
    actionId: randomUUID(),
    input: { prompt: "A red square slides in", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } },
    inputHash: `sha256:${randomUUID()}`,
    deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });
  if (inserted === null) throw new Error("Fixture execution conflicted");
  const step = async (event: Parameters<typeof timelineExecutionRepo.transition>[0]["event"]): Promise<TimelineExecution> => {
    const result = await timelineExecutionRepo.transition({ id: inserted.id, event });
    if (!result.applied) throw new Error(`Fixture step ${event.type} refused`);
    return result.row;
  };
  let execution = inserted;
  if (state !== "awaiting_landing") {
    await step({ type: "land", inputHash: inserted.inputHash });
    execution = await read(inserted.id);
  }
  if (state === "running" || state === "cancelling") execution = await step({ type: "claim" });
  if (state === "cancelling") execution = await step({ type: "cancel" });
  return {
    execution,
    projectId,
    spaceId,
    studioId,
    userId,
    packageKey: `web-animation/${projectId}/${inserted.id}/index.html`,
    manifestKey: `web-animation/${projectId}/${inserted.id}/manifest.json`,
  };
}

/**
 * Read an execution back.
 * @param id - The execution.
 * @returns The row.
 * @throws {Error} When it is missing.
 */
export async function read(id: string): Promise<TimelineExecution> {
  const row = await timelineExecutionRepo.findById(id);
  if (row === undefined) throw new Error("Execution missing");
  return row;
}

/**
 * The credit holds keyed by an execution; an execution never has one.
 * @param sql - The suite's own connection.
 * @param executionId - The execution.
 * @returns The statuses of the holds found.
 */
export async function holdsFor(sql: Sql, executionId: string): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id = ${executionId}`;
  return rows.map((row) => row.status);
}

/** A usage row as these suites compare it. */
export interface UsageRowView {
  source: string;
  provider: string;
  model: string;
  feature: string;
  cost_identity: string | null;
  cost_source: string;
  cost_usd: number;
  credits: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

/**
 * The usage rows recorded under an execution's operation key, model calls by identity first, then the container.
 * @param sql - The suite's own connection.
 * @param executionId - The execution.
 * @returns The rows.
 */
export async function usageRows(sql: Sql, executionId: string): Promise<UsageRowView[]> {
  const rows = await sql<(Omit<UsageRowView, "cost_usd" | "credits"> & { cost_usd: string; credits: string })[]>`
    SELECT source, provider, model, feature, cost_identity, cost_source, cost_usd::text AS cost_usd, credits::text AS credits,
           input_tokens, cached_input_tokens, output_tokens, reasoning_tokens
    FROM agent_usage_records WHERE operation_key = ${`timeline:${executionId}`}
    ORDER BY cost_identity NULLS LAST, source
  `;
  return rows.map((row) => ({ ...row, cost_usd: Number(row.cost_usd), credits: Number(row.credits) }));
}

/**
 * The source versions an execution produced.
 * @param sql - The suite's own connection.
 * @param executionId - The execution.
 * @returns Their rows.
 */
export async function sourceRows(sql: Sql, executionId: string): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    SELECT id, package_key, manifest_key, package_sha256, package_bytes::int AS package_bytes, manifest_sha256, runtime_version,
           font_set_version, width, height, fps_num, fps_den, duration_frames
    FROM timeline_web_animation_sources WHERE execution_id = ${executionId}
  `;
}

const SHA_PACKAGE = "a".repeat(64);
const SHA_MANIFEST = "b".repeat(64);

/** The four kinds of call a report may list, with the figures these suites settle. */
export const CALLS = {
  completed: { seq: 1, generationId: "gen-1", tokens: { input: 1_200, output: 300, reasoning: 100, cacheRead: 200 }, costUsd: 0.0125, outcome: "completed" },
  upstreamError: { seq: 2, generationId: null, tokens: null, costUsd: null, outcome: "upstream_error" },
  interrupted: { seq: 3, generationId: "gen-3", tokens: { input: 900, output: 40, reasoning: 0, cacheRead: 0 }, costUsd: null, outcome: "interrupted" },
  cutOff: { seq: 4, generationId: "gen-4", tokens: null, costUsd: null, outcome: "cut_off" },
} satisfies Record<string, WebAnimationJobCall>;

/**
 * A report in the given state.
 * @param fx - The execution.
 * @param state - The job's state.
 * @param overrides - Fields a case varies.
 * @returns The report.
 */
export function report(
  fx: ExecutionFixture,
  state: WebAnimationJobReport["state"],
  overrides: Partial<WebAnimationJobReport> = {},
): WebAnimationJobReport {
  return {
    state,
    phase: state === "running" ? "writing" : null,
    steps: [],
    calls: [CALLS.completed, CALLS.upstreamError, CALLS.interrupted],
    container: { wallMs: 60_000, cpuUsec: 30_000_000 },
    outputs: state === "done"
      ? [
        { key: fx.packageKey, sha256: SHA_PACKAGE, bytes: 612_345 },
        { key: fx.manifestKey, sha256: SHA_MANIFEST, bytes: 321 },
      ]
      : [],
    failureReason: state === "failed" ? "dsh_failed" : null,
    ...overrides,
  };
}

/**
 * The Manifest a job for the fixture writes.
 * @param overrides - Fields a case varies.
 * @returns It.
 */
export function manifest(overrides: Partial<WebAnimationManifest> = {}): WebAnimationManifest {
  return {
    schemaVersion: 1,
    entrypoint: "index.html",
    viewport: { width: 1920, height: 1080 },
    fps: { num: 24, den: 1 },
    durationFrames: 96,
    resources: [{ kind: "font-set", version: 1 }],
    runtime: { id: "hyperframes", version: "0.8.186" },
    ...overrides,
  };
}

/**
 * The source row a done report and the default Manifest record.
 * @param fx - The execution.
 * @param fontSetVersion - The font set the yaml names.
 * @returns The row as {@link sourceRows} reads it.
 */
export function expectedSource(fx: ExecutionFixture, fontSetVersion: number): Record<string, unknown> {
  return {
    id: expect.any(String),
    package_key: fx.packageKey,
    manifest_key: fx.manifestKey,
    package_sha256: SHA_PACKAGE,
    package_bytes: 612_345,
    manifest_sha256: SHA_MANIFEST,
    runtime_version: "@hyperframes/core@0.8.186",
    font_set_version: fontSetVersion,
    width: 1920,
    height: 1080,
    fps_num: 24,
    fps_den: 1,
    duration_frames: 96,
  };
}

/**
 * Serve a Manifest from storage for the fixture's key; any other read fails.
 * @param fx - The execution.
 * @param body - The Manifest.
 */
export async function serveManifest(fx: ExecutionFixture, body: WebAnimationManifest): Promise<void> {
  vi.spyOn(await getStorageAdapter(), "read").mockImplementation(async (key: string) => {
    if (key !== fx.manifestKey) throw new Error(`unexpected storage read of ${key}`);
    return new TextEncoder().encode(JSON.stringify(body));
  });
}

/** One request the stand-in Worker received. */
export interface IngestCall {
  method: string;
  route: "submit" | "read" | "cancel";
  jobId: string;
  body: Record<string, unknown> | null;
}

/** A stand-in for the ingest Worker's web-animation job routes. */
export interface FakeIngest {
  calls: IngestCall[];
  /** Answers a submit; default: the job runs. */
  submit: (body: Record<string, unknown>) => Response;
  /** Answers a read; default: no such job. */
  read: (jobId: string) => Response;
  /** Answers a cancel; default: the job is cancelled with no calls. */
  cancel: (jobId: string, body: Record<string, unknown>) => Response;
}

/**
 * A JSON answer.
 * @param body - What to send.
 * @param status - The status.
 * @returns The response.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * An answer with no job.
 * @returns A 404.
 */
export function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * The ingest Worker's answer when web-animation execution is not configured.
 * @returns A 501.
 */
export function featureDisabled(): Response {
  return new Response("feature_disabled", { status: 501 });
}

/**
 * Stand in for the ingest Worker on `env.INGEST_BASE_URL`; any other address is a test failure.
 * @param fx - The execution whose job the answers describe.
 * @returns The stand-in, whose answers a case replaces.
 */
export function installFakeIngest(fx: ExecutionFixture): FakeIngest {
  const fake: FakeIngest = {
    calls: [],
    submit: () => json(report(fx, "running", { calls: [], outputs: [] })),
    read: () => notFound(),
    cancel: () => json(report(fx, "cancelled", { calls: [], container: null })),
  };
  const jobsPath = `${env.INGEST_BASE_URL}/jobs`;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (!url.startsWith(jobsPath)) throw new Error(`unexpected request to ${url}`);
    const rest = url.slice(jobsPath.length);
    if (rest === "" && method === "POST") {
      fake.calls.push({ method, route: "submit", jobId: String(body?.jobId), body });
      return fake.submit(body ?? {});
    }
    const match = new RegExp(`^/${WEB_ANIMATION_CONTAINER_CLASS}/([^/]+)(/cancel)?$`).exec(rest);
    if (match === null) throw new Error(`unexpected ingest route ${method} ${rest}`);
    const jobId = decodeURIComponent(match[1]!);
    if (match[2] !== undefined && method === "POST") {
      fake.calls.push({ method, route: "cancel", jobId, body });
      return fake.cancel(jobId, body ?? {});
    }
    if (method === "GET") {
      fake.calls.push({ method, route: "read", jobId, body: null });
      return fake.read(jobId);
    }
    throw new Error(`unexpected ingest route ${method} ${rest}`);
  });
  return fake;
}

/** A BullMQ job as the timeline processor receives it. */
export interface FakeJob {
  id: string;
  name: string;
  data: { executionId: string };
  opts: { attempts: number };
  attemptsMade: number;
  extendLock: ReturnType<typeof vi.fn>;
  moveToDelayed: ReturnType<typeof vi.fn>;
  updateProgress: ReturnType<typeof vi.fn>;
}

/**
 * A job for an execution whose lock answers as given.
 * @param executionId - The execution.
 * @param lockAnswers - What each successive `extendLock` answers; past the list, the last answer repeats. Default: held.
 * @returns The job.
 */
export function jobFor(executionId: string, lockAnswers: number[] = [1]): FakeJob {
  let call = 0;
  return {
    id: executionId,
    name: "timeline-execution",
    data: { executionId },
    opts: { attempts: 3 },
    attemptsMade: 0,
    extendLock: vi.fn(async () => lockAnswers[Math.min(call++, lockAnswers.length - 1)]!),
    moveToDelayed: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => {}),
  };
}

/**
 * Hand a stand-in job to the processor under BullMQ's type.
 * @param job - The stand-in.
 * @returns It, typed as the processor receives it.
 */
export function asJob(job: FakeJob): Job<{ executionId: string }> {
  return job as unknown as Job<{ executionId: string }>;
}

/**
 * Whether an error only says the job waits for a later pickup.
 * @param err - What a pickup threw.
 * @returns True for `StillRunning` and BullMQ's `DelayedError`.
 */
export function isWaiting(err: unknown): boolean {
  return err instanceof Error && (err.name === "StillRunning" || err.name === "DelayedError");
}

/**
 * Send every log line of this process to a fresh file sink, so a suite can read what any logger of the code under
 * test wrote, children included.
 * @param serviceName - The sink's service name.
 * @returns A reader of the error-level records written so far.
 */
export function captureErrorLogs(serviceName: string): () => Record<string, unknown>[] {
  const logsRoot = mkdtempSync(join(tmpdir(), `${serviceName}-`));
  initLogger(serviceName, { logsRoot, debug: false, console: "none" });
  return () => readdirSync(join(logsRoot, serviceName))
    .flatMap((file) => readFileSync(join(logsRoot, serviceName, file), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.level === 50);
}
