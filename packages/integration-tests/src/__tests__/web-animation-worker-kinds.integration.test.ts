// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The worker's two new kinds (#1490 design §5.2, §6.2–§6.6).
 *
 * A modification submits a creation job that names the package its base result was made from, with that result's
 * frame and length, and records a new source version like a create. An export submits a render job to its own
 * container class with the frozen frame and length and the two output keys acceptance minted; a done report hands
 * the video's ingest report to registration, the row succeeds with the registered asset, and only the container's use
 * is recorded. A render that fails names why, and a registration that does not register fails the row as not saved.
 *
 * Real database; the ingest Worker is the shared stand-in, and only the credit engine's settle is a double.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

const settle = vi.hoisted(() => vi.fn(async (_requestId: string): Promise<Record<string, unknown> | null> => null));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, creditLotService: { ...actual.creditLotService, settleCharge: settle } };
});

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: (_count: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import type * as DomainModule from "@breatic/domain";
import { randomUUID } from "node:crypto";
import { coverKeyFor, createPgClient, getTimelineConfig, initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import { createUsageRecorder, initProvider, timelineOperationKey, toChargeCredits, uploadGrantService, webAnimationSourceRepo } from "@breatic/domain";
import { durationToFrames } from "@breatic/shared";
import {
  WEB_ANIMATION_CONTAINER_CLASS, WEB_ANIMATION_RENDER_CONTAINER_CLASS, webAnimationJobRequestSchema, webAnimationRenderJobRequestSchema,
} from "@breatic/shared/space-content";
import { runTimelineExecution } from "@worker/handlers/timeline/web-animation-execution.js";
import {
  asJob, installFakeIngest, isWaiting, jobFor, json, read, seedExecution, usageRows, type ExecutionFixture,
} from "@integration-tests/__tests__/timeline-worker-fixtures.js";

let sql: ReturnType<typeof createPgClient>;
const owned: string[] = [];
const FPS = { num: 24, den: 1 };
const SHA = "d".repeat(64);
/** The cover's own hash: the same bytes as the video would be filed as one asset. */
const COVER_SHA = "e".repeat(64);

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  initProvider();
  sql = createPgClient(inject("DATABASE_URL"), { name: "web-animation-kinds-driver", max: 4, prepare: false });
});

beforeEach(() => {
  settle.mockReset();
  settle.mockImplementation(async () => ({ billed: true, charged: "0", shortfall: "0", studioId: null, lotIds: [] }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (owned.length > 0) await sql`UPDATE timeline_executions SET deleted_at = now() WHERE id = ANY(${owned}::uuid[])`;
  owned.length = 0;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Write a finished result in a fixture's Project: a create row and its source version.
 * @param fx - The fixture whose Project it belongs to.
 * @param size - Its frame and length.
 * @param size.width - Width.
 * @param size.height - Height.
 * @param size.durationFrames - Length.
 * @returns The source version.
 */
async function baseResult(fx: ExecutionFixture, size = { width: 1920, height: 1080, durationFrames: 96 }): Promise<{ id: string; packageKey: string }> {
  const created = await timelineExecutionRepo.insert({
    projectId: fx.projectId, spaceId: fx.spaceId, actorUserId: fx.userId, kind: "web_animation_create", engine: "deepseek",
    actionId: randomUUID(), input: { prompt: "A logo", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS },
    inputHash: `sha256:${randomUUID()}`, deadlineAt: new Date(Date.now() + 7_200_000), status: "queued", origin: "web_animation_space",
  });
  if (created === null) throw new Error("Fixture execution conflicted");
  owned.push(created.id);
  const packageKey = `web-animation/${fx.projectId}/${created.id}/index.html`;
  const version = await webAnimationSourceRepo.insert({
    executionId: created.id, packageKey, manifestKey: `web-animation/${fx.projectId}/${created.id}/manifest.json`,
    packageSha256: "a".repeat(64), packageBytes: 500_000, manifestSha256: "b".repeat(64), runtimeVersion: "@hyperframes/core@0.8.186",
    fontSetVersion: 1, width: size.width, height: size.height, fpsNum: 24, fpsDen: 1, durationFrames: size.durationFrames,
  });
  return { id: version.id, packageKey };
}

/**
 * Run one pickup; waiting for a later pickup is a normal outcome.
 * @param fx - The execution.
 */
async function pickUp(fx: ExecutionFixture): Promise<void> {
  try {
    await runTimelineExecution(asJob(jobFor(fx.execution.id)), "lock-token");
  } catch (err) {
    if (!isWaiting(err)) throw err;
  }
}

/**
 * Seed an export of a fresh result, with the video upload acceptance opens; its cover rides with it.
 * @param state - Where the export starts.
 * @returns The export, its source and its video key.
 */
async function seedExport(state: "queued" | "running"): Promise<{ fx: ExecutionFixture; source: { id: string; packageKey: string }; videoKey: string }> {
  const holder = await seedExecution(sql, "queued");
  owned.push(holder.execution.id);
  const source = await baseResult(holder, { width: 1080, height: 1920, durationFrames: 144 });
  const grant = await uploadGrantService.issueUploadGrant({
    projectId: holder.projectId, actingUserId: holder.userId, declaredSize: 1, taskType: "web_animation_export", ext: ".mp4",
    expiresAt: new Date(Date.now() + 7_200_000), context: { assetSource: "ai", derived: true, generationTaskId: null },
  });
  const fx = await seedExecution(sql, state, {
    kind: "web_animation_export",
    input: { sourceVersionId: source.id, width: 1080, height: 1920, fps: FPS, durationFrames: 144, videoKey: grant.key },
  });
  owned.push(fx.execution.id);
  return { fx, source, videoKey: grant.key };
}

/**
 * A render report.
 * @param state - The job's state.
 * @param overrides - Fields a case varies.
 * @returns It.
 */
function renderReport(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state, phase: state === "running" ? "rendering" : null, progress: state === "done" ? 1 : 0.4, container: { wallMs: 90_000, cpuUsec: 300_000_000 }, video: null, failureReason: null, ...overrides };
}

describe("a modification", () => {
  it("submits a creation job that starts from its base package, with the base's frame and length", async () => {
    const holder = await seedExecution(sql, "queued");
    owned.push(holder.execution.id);
    const base = await baseResult(holder);
    const fx = await seedExecution(sql, "queued", {
      kind: "web_animation_modify",
      input: { baseSourceVersionId: base.id, instruction: "Make it slower", engine: "deepseek", aspect: "9:16", durationSeconds: 6, fps: FPS },
    });
    owned.push(fx.execution.id);
    const ingest = installFakeIngest(fx);
    await pickUp(fx);
    const submit = ingest.calls.find((call) => call.route === "submit");
    expect(submit?.containerClass).toBe(WEB_ANIMATION_CONTAINER_CLASS);
    const job = webAnimationJobRequestSchema.parse(submit?.body);
    expect(job).toMatchObject({
      prompt: "Make it slower",
      fps: FPS,
      durationFrames: durationToFrames(6, FPS),
      base: { packageKey: base.packageKey, viewport: { width: 1920, height: 1080 }, durationFrames: 96, fontSetVersion: 1 },
    });
    expect(job.viewport.height).toBeGreaterThan(job.viewport.width);
  });
});

describe("an export", () => {
  it("submits a render job on its own class with the frozen frame, the source package and the two output keys", async () => {
    const { fx, source, videoKey } = await seedExport("queued");
    const ingest = installFakeIngest(fx);
    ingest.submit = () => json(renderReport("running"));
    await pickUp(fx);
    const submit = ingest.calls.find((call) => call.route === "submit");
    expect(submit?.containerClass).toBe(WEB_ANIMATION_RENDER_CONTAINER_CLASS);
    expect(webAnimationRenderJobRequestSchema.parse(submit?.body)).toEqual({
      containerClass: WEB_ANIMATION_RENDER_CONTAINER_CLASS,
      jobId: `timeline:${fx.execution.id}`,
      deadlineAt: Date.parse(fx.execution.deadlineAt),
      packageKey: source.packageKey,
      fontSetVersion: 1,
      width: 1080,
      height: 1920,
      fps: FPS,
      durationFrames: 144,
      quality: getTimelineConfig().web_animation.render_quality,
      videoKey,
      coverKey: coverKeyFor(videoKey),
    });
    expect(await read(fx.execution.id)).toMatchObject({ status: "running" });
  });

  it("shows the rendering phase while the render runs", async () => {
    const { fx } = await seedExport("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(renderReport("running"));
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "running", phase: "rendering" });
  });

  it("registers a done render's video, succeeds with the asset and records only the container", async () => {
    const { fx, videoKey } = await seedExport("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(renderReport("done", {
      video: {
        storageKey: videoKey, sha256: SHA, sizeBytes: 4_000_000, contentType: "video/mp4", width: 1080, height: 1920, durationSeconds: 6,
        cover: { storageKey: coverKeyFor(videoKey), sha256: COVER_SHA, sizeBytes: 90_000, contentType: "image/png", width: 1080, height: 1920 },
      },
    }));
    await pickUp(fx);
    const [asset] = await sql<{ id: string; kind: string; source: string }[]>`SELECT id, kind, source FROM studio_assets WHERE storage_key = ${videoKey} AND deleted_at IS NULL`;
    expect(asset).toMatchObject({ kind: "video", source: "ai" });
    expect(await read(fx.execution.id)).toMatchObject({ status: "succeeded", resultAssetId: asset!.id, resultSourceVersionId: null, fence: null });
    const rows = await usageRows(sql, fx.execution.id);
    expect(rows).toEqual([expect.objectContaining({ source: "container", provider: "cloudflare", model: "cloudflare-container:web_animation_render" })]);
  });

  it.each(["render_failed", "frame_mismatch"])("fails with %s when the render does, still recording the container", async (reason) => {
    const { fx } = await seedExport("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(renderReport("failed", { failureReason: reason }));
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "failed", failureReason: reason, resultAssetId: null });
    expect(await usageRows(sql, fx.execution.id)).toEqual([expect.objectContaining({ source: "container", model: "cloudflare-container:web_animation_render" })]);
  });

  it("records the container once and charges it once when a pickup that lost its lock already recorded it", async () => {
    const { fx } = await seedExport("running");
    // The earlier pickup wrote the container's row, then lost the job lock before it charged.
    const earlier = createUsageRecorder({
      operationKey: timelineOperationKey(fx.execution.id), feature: "timeline_web_animation",
      actorUserId: fx.userId, projectId: fx.projectId, onMissingCost: () => {},
    });
    earlier.recordServiceCall({ source: "container", service: "cloudflare-container:web_animation_render", provider: "cloudflare", requests: 1, costUsd: 0.5, costSource: "computed" });
    await earlier.settle();
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(renderReport("failed", { failureReason: "render_failed" }));
    await pickUp(fx);
    const rows = await usageRows(sql, fx.execution.id);
    expect(rows).toHaveLength(1);
    const [billed] = await sql<{ billed_credits: string }[]>`SELECT billed_credits::text FROM timeline_executions WHERE id = ${fx.execution.id}`;
    expect(Number(billed!.billed_credits)).toBe(toChargeCredits(rows[0]!.credits));
  });

  it("fails as not saved when the video's registration does not register it", async () => {
    const { fx } = await seedExport("running");
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(renderReport("done", {
      video: { storageKey: `generated/never-granted-${randomUUID()}.mp4`, sha256: SHA, sizeBytes: 4_000_000, contentType: "video/mp4", width: 1080, height: 1920, durationSeconds: 6, cover: null },
    }));
    await pickUp(fx);
    expect(await read(fx.execution.id)).toMatchObject({ status: "failed", failureReason: "save_failed", resultAssetId: null });
  });

  it("sends a cancel to the render container class", async () => {
    const { fx } = await seedExport("running");
    await timelineExecutionRepo.transition({ id: fx.execution.id, event: { type: "cancel" } });
    const ingest = installFakeIngest(fx);
    ingest.read = () => json(renderReport("running"));
    ingest.cancel = () => json(renderReport("cancelled", { container: null }));
    await pickUp(fx);
    expect(ingest.calls.filter((call) => call.route === "cancel").map((call) => call.containerClass)).toEqual([WEB_ANIMATION_RENDER_CONTAINER_CLASS]);
  });
});
