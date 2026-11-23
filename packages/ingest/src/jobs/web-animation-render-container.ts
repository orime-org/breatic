// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The render container (#1490 design §6): one Durable Object per export, named by the job id, driving one run of the
 * HyperFrames renderer over a source package.
 *
 * The container has no internet. It reads the one source package and writes the video and its first-frame cover
 * through `r2.local`, and reports through `jobs.local`, each answered by an outbound handler here. Each write is
 * streamed to R2 and the stored bytes are hashed, measured and typed here, as a mini-tool's outputs are; the report
 * joins those with the media numbers the runner measured, which is what registration files.
 */

import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext, StopParams } from "@cloudflare/containers";
import type { WebAnimationRenderJobReport, WebAnimationRenderJobRequest } from "@breatic/shared/space-content";

import { noteFailure } from "@ingest/error-monitoring.js";
import { askedKey } from "@ingest/object-url.js";
import { MEDIA_OBJECT_HOST, mediaObjectUrl } from "@ingest/media-object-route.js";
import { JOB_REPORT_HOST, JobStartFailed } from "@ingest/jobs/mini-tool-container.js";
import { readWebAnimationPackage } from "@ingest/jobs/web-animation-container.js";
import {
  WEB_ANIMATION_PORT,
  WEB_ANIMATION_PROGRESS_PATH,
  WEB_ANIMATION_REPORT_PATH,
  WEB_ANIMATION_RUN_PATH,
  type WebAnimationRenderReportBody,
  type WebAnimationRenderRunBody,
} from "@ingest/jobs/web-animation-run-body.js";
import { hashStoredObject, sniffStoredObject, writeStreamedObject } from "@ingest/stored-object.js";

/** What this class needs bound; the binding is optional, and its absence turns exports off. */
export interface WebAnimationRenderEnv {
  BUCKET: R2Bucket;
  WEB_ANIMATION_RENDER?: DurableObjectNamespace<WebAnimationRenderContainer>;
}

/** One stored output as the edge measured it. */
export interface RenderOutput {
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

/** What a submit answers. */
export type RenderSubmitAnswer = { kind: "report"; report: WebAnimationRenderJobReport } | { kind: "cancelled_before_submit" };

/** The keys a render job reads and writes. */
interface RenderObjects {
  packageKey: string;
  videoKey: string;
  coverKey: string;
}

type Terminal = "done" | "failed" | "cancelled" | "expired";

/** The stored job. */
interface RenderRecord {
  state: WebAnimationRenderJobReport["state"];
  /** Null only for the pre-submit cancel marker. */
  request: WebAnimationRenderJobRequest | null;
  markerUntil: number | null;
  phase: WebAnimationRenderJobReport["phase"];
  progress: number | null;
  outputs: RenderOutput[];
  media: Pick<WebAnimationRenderReportBody, "video" | "cover">;
  startedAt: number | null;
  endedAt: number | null;
  cpuUsec: number | null;
  failureReason: string | null;
}

const RECORD = "job";
const ACCEPTED = "accepted";
const PART_SIZE = 32 * 1024 * 1024;
const MAX_PARTS = 64;
const TERMINAL: ReadonlySet<RenderRecord["state"]> = new Set(["done", "failed", "cancelled", "expired"]);
const JOB_OBJECTS = "jobObjects";
const JOB_REPORT = "jobReport";

/**
 * Store the render's video or cover, measuring the bytes that landed.
 * @param request - The container's request on `r2.local`.
 * @param bucket - The R2 binding.
 * @param job - The two keys the job may write.
 * @param job.videoKey - The video's key.
 * @param job.coverKey - The cover's key.
 * @returns The answer for the container, and what was stored when something was.
 * @throws {Error} When R2 refuses the write.
 */
export async function storeWebAnimationRenderOutput(
  request: Request,
  bucket: R2Bucket,
  job: { videoKey: string; coverKey: string },
): Promise<{ response: Response; written: RenderOutput | null }> {
  if (request.method !== "PUT") return { response: new Response("Not allowed", { status: 405 }), written: null };
  const key = askedKey(request);
  if (key !== job.videoKey && key !== job.coverKey) return { response: new Response("Not this object", { status: 403 }), written: null };
  if (request.body === null) return { response: new Response("No body", { status: 400 }), written: null };
  const contentType = key === job.videoKey ? "video/mp4" : "image/png";
  const stored = await writeStreamedObject(bucket, key, request.body, { contentType, partSize: PART_SIZE, maxBytes: PART_SIZE * MAX_PARTS });
  if (stored === "over_cap") return { response: new Response("Too large", { status: 413 }), written: null };
  const written = {
    key,
    sha256: await hashStoredObject(bucket, key),
    sizeBytes: stored.sizeBytes,
    contentType: await sniffStoredObject(bucket, key),
  };
  return { response: new Response(null, { status: 200 }), written };
}

/**
 * A job record with nothing done yet.
 * @param state - Its state.
 * @param request - Its request.
 * @returns The record.
 */
function blank(state: RenderRecord["state"], request: WebAnimationRenderJobRequest | null): RenderRecord {
  return {
    state, request, markerUntil: null, phase: null, progress: null, outputs: [], media: { video: null, cover: null },
    startedAt: null, endedAt: null, cpuUsec: null, failureReason: null,
  };
}

/**
 * End a running job.
 * @param record - The job.
 * @param state - How it ends.
 * @param failureReason - Why, for a failure.
 * @param now - Epoch ms.
 * @returns The ended job.
 */
function end(record: RenderRecord, state: Terminal, failureReason: string | null, now: number): RenderRecord {
  return { ...record, state, failureReason: state === "failed" ? failureReason : null, endedAt: now };
}

/**
 * What a job answers.
 * @param record - The job, or null.
 * @param now - Epoch ms.
 * @returns The report, or null when there is no job.
 */
function reportOf(record: RenderRecord | null, now: number): WebAnimationRenderJobReport | null {
  if (record === null) return null;
  const output = (key: string | undefined): RenderOutput | undefined => record.outputs.find((held) => held.key === key);
  const video = output(record.request?.videoKey);
  const cover = output(record.request?.coverKey);
  return {
    state: record.state,
    phase: record.phase,
    progress: record.progress,
    container: record.startedAt === null ? null : { wallMs: (record.endedAt ?? now) - record.startedAt, cpuUsec: record.cpuUsec },
    video: record.state !== "done" || video === undefined || record.media.video === null
      ? null
      : {
        storageKey: video.key, sha256: video.sha256, sizeBytes: video.sizeBytes, contentType: video.contentType, ...record.media.video,
        cover: cover === undefined || record.media.cover === null
          ? null
          : { storageKey: cover.key, sha256: cover.sha256, sizeBytes: cover.sizeBytes, contentType: cover.contentType, ...record.media.cover },
      },
    failureReason: record.failureReason,
  };
}

/** One export's render job and its container. */
export class WebAnimationRenderContainer extends Container<WebAnimationRenderEnv> {
  defaultPort = WEB_ANIMATION_PORT;

  /** No route out but the handlers below. */
  enableInternet = false;

  /** Carries that refusal to HTTPS as well. */
  interceptHttps = true;

  /**
   * Start a render, or answer the one this object already holds.
   * @param request - The job.
   * @returns Its report, or that a cancel came first.
   * @throws {JobStartFailed} When the container could not be started or would not take the run.
   */
  async submit(request: WebAnimationRenderJobRequest): Promise<RenderSubmitAnswer> {
    const now = Date.now();
    const started = await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.load();
      if (record?.state === "cancelled_before_submit" && now < (record.markerUntil ?? 0)) return "refused" as const;
      if (record !== null && record.state !== "cancelled_before_submit") return "held" as const;
      const next = now >= request.deadlineAt ? { ...blank("expired", request), endedAt: now } : { ...blank("running", request), startedAt: now };
      await this.ctx.storage.put(RECORD, next);
      return next.state === "running" ? ("start" as const) : ("held" as const);
    });
    if (started === "refused") return { kind: "cancelled_before_submit" };
    if (started === "start") await this.startRun(request);
    return { kind: "report", report: reportOf(await this.load(), Date.now())! };
  }

  /**
   * The job's report, noticing a live job whose container is gone.
   * @returns The report, or null when this object holds no job.
   */
  async report(): Promise<WebAnimationRenderJobReport | null> {
    const record = await this.load();
    if (record?.state === "running" && (await this.ctx.storage.get<boolean>(ACCEPTED)) === true && this.ctx.container?.running !== true) {
      await this.update((held) => (held.state === "running" ? end(held, "failed", "container_gone", Date.now()) : held));
    }
    return reportOf(await this.load(), Date.now());
  }

  /**
   * Cancel the job; with none yet, keep a marker refusing its submit until `deadlineAt`.
   * @param deadlineAt - The job's deadline, epoch ms.
   * @returns The report after the cancel.
   */
  async cancel(deadlineAt: number): Promise<WebAnimationRenderJobReport> {
    const record = await this.ctx.blockConcurrencyWhile(async () => {
      const held = await this.load();
      if (held === null) {
        const marker = { ...blank("cancelled_before_submit", null), markerUntil: deadlineAt };
        await this.ctx.storage.put(RECORD, marker);
        return marker;
      }
      if (held.state !== "running") return held;
      const ended = end(held, "cancelled", null, Date.now());
      await this.ctx.storage.put(RECORD, ended);
      return ended;
    });
    if (record.state === "cancelled") await this.stopContainer();
    if (record.state === "cancelled_before_submit" && deadlineAt > Date.now()) await this.schedule(new Date(deadlineAt), "expireMarker");
    return reportOf(record, Date.now())!;
  }

  /**
   * One output the container wrote.
   * @param output - What the edge measured.
   * @returns Nothing.
   */
  async noteWritten(output: RenderOutput): Promise<void> {
    await this.update((held) => (held.state === "running" ? { ...held, outputs: [...held.outputs.filter((o) => o.key !== output.key), output] } : held));
  }

  /**
   * The renderer's phase and how far it got.
   * @param phase - The phase.
   * @param progress - How far it got, 0 to 1.
   * @returns Nothing.
   */
  async noteProgress(phase: "rendering" | "saving", progress: number): Promise<void> {
    await this.update((held) => (held.state === "running" ? { ...held, phase, progress } : held));
  }

  /**
   * The runner's final report: a done render needs both outputs stored and their media measured.
   * @param report - What the runner posted.
   * @param report.ok - Whether it rendered and stored both outputs.
   * @param report.failureReason - Why not.
   * @param report.cpuUsec - The CPU time its cgroup counted.
   * @param report.video - What it measured of the video.
   * @param report.cover - What it measured of the cover.
   * @returns Nothing.
   */
  async noteFinished(report: WebAnimationRenderReportBody): Promise<void> {
    const ended = await this.update((held) => {
      if (held.state !== "running") return held;
      const withRun = { ...held, cpuUsec: report.cpuUsec, media: { video: report.video, cover: report.cover }, progress: report.ok ? 1 : held.progress };
      const stored = [held.request?.videoKey, held.request?.coverKey].every((key) => held.outputs.some((output) => output.key === key));
      if (report.ok && stored && report.video !== null) return end(withRun, "done", null, Date.now());
      return end(withRun, "failed", report.ok ? "save_failed" : (report.failureReason ?? "render_failed"), Date.now());
    });
    if (ended !== null && TERMINAL.has(ended.state)) await this.stopContainer();
  }

  /**
   * The job's deadline.
   * @returns Nothing.
   */
  async expireJob(): Promise<void> {
    const ended = await this.update((held) => (held.state === "running" ? end(held, "expired", null, Date.now()) : held));
    if (ended?.state === "expired") await this.stopContainer();
  }

  /**
   * Drop the pre-submit cancel marker once its deadline has passed.
   * @returns Nothing.
   */
  async expireMarker(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.load();
      if (record?.state === "cancelled_before_submit" && Date.now() >= (record.markerUntil ?? 0)) await this.ctx.storage.delete(RECORD);
    });
  }

  /**
   * The container stopped: a job still running then failed.
   * @param _params - How it stopped.
   * @returns Nothing.
   */
  override async onStop(_params: StopParams): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(ACCEPTED)) !== true) return;
    await this.update((held) => (held.state === "running" ? end(held, "failed", "container_gone", Date.now()) : held));
  }

  /**
   * The container failed outside a request.
   * @param error - What went wrong.
   * @returns Nothing.
   */
  override async onError(error: unknown): Promise<void> {
    noteFailure("ingest_web_animation_render_container_error", { containerId: this.ctx.id.toString() }, error);
    await this.onStop({} as StopParams);
  }

  /**
   * Keep a live render's container: the renderer makes no request into it while it works.
   * @returns Nothing.
   */
  override async onActivityExpired(): Promise<void> {
    if ((await this.load())?.state === "running") return;
    await this.destroy();
  }

  /**
   * Start the container and hand it the render.
   * @param request - The job.
   * @returns Nothing.
   * @throws {JobStartFailed} When the container could not be started or would not take the run.
   */
  private async startRun(request: WebAnimationRenderJobRequest): Promise<void> {
    await this.schedule(new Date(request.deadlineAt), "expireJob");
    const objects: RenderObjects = { packageKey: request.packageKey, videoKey: request.videoKey, coverKey: request.coverKey };
    const run: WebAnimationRenderRunBody = {
      packageUrl: mediaObjectUrl(request.packageKey),
      fontSetVersion: request.fontSetVersion,
      width: request.width,
      height: request.height,
      fps: request.fps,
      durationFrames: request.durationFrames,
      quality: request.quality,
      videoUrl: mediaObjectUrl(request.videoKey),
      coverUrl: mediaObjectUrl(request.coverKey),
      progressUrl: `http://${JOB_REPORT_HOST}${WEB_ANIMATION_PROGRESS_PATH}`,
      reportUrl: `http://${JOB_REPORT_HOST}${WEB_ANIMATION_REPORT_PATH}`,
    };
    try {
      await this.setOutboundByHosts<unknown>({
        [MEDIA_OBJECT_HOST]: { method: JOB_OBJECTS, params: objects },
        [JOB_REPORT_HOST]: JOB_REPORT,
      });
      await this.start();
      const answered = await this.containerFetch(new Request(`http://job${WEB_ANIMATION_RUN_PATH}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(run),
      }));
      if (answered.status !== 202) throw new JobStartFailed(`the render was answered ${answered.status}`);
    } catch (err) {
      this.deleteSchedules("expireJob");
      await this.ctx.storage.delete([RECORD, ACCEPTED]);
      await this.destroy().catch(() => undefined);
      throw err instanceof JobStartFailed ? err : new JobStartFailed(String(err));
    }
    await this.ctx.storage.put(ACCEPTED, true);
  }

  /**
   * Stop the container of a job that ended.
   * @returns Nothing.
   */
  private async stopContainer(): Promise<void> {
    this.deleteSchedules("expireJob");
    await this.destroy().catch(() => undefined);
  }

  /**
   * Change the stored job in one serialized read and write.
   * @param change - What the job becomes.
   * @returns The job after the change, or null when there is none.
   */
  private async update(change: (record: RenderRecord) => RenderRecord): Promise<RenderRecord | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.load();
      if (record === null) return null;
      const next = change(record);
      if (next !== record) await this.ctx.storage.put(RECORD, next);
      return next;
    });
  }

  /**
   * The stored job.
   * @returns It, or null.
   */
  private async load(): Promise<RenderRecord | null> {
    return (await this.ctx.storage.get<RenderRecord>(RECORD)) ?? null;
  }
}

/**
 * The job object an outbound handler answers for.
 * @param env - The bindings.
 * @param ctx - The handler's context, naming the object.
 * @returns The object's stub.
 * @throws {Error} When the binding is gone, which cannot happen while one of its containers runs.
 */
function jobObject(env: WebAnimationRenderEnv, ctx: OutboundHandlerContext<unknown>): DurableObjectStub<WebAnimationRenderContainer> {
  const namespace = env.WEB_ANIMATION_RENDER;
  if (namespace === undefined) throw new Error("WEB_ANIMATION_RENDER is not bound");
  return namespace.get(namespace.idFromString(ctx.containerId));
}

/**
 * Read the source package, or write the video or its cover.
 * @param request - What the container sent to `r2.local`.
 * @param env - The bindings.
 * @param ctx - The handler's context, carrying the job's keys.
 * @returns The read or the write's answer.
 */
async function jobObjects(request: Request, env: WebAnimationRenderEnv, ctx: OutboundHandlerContext<RenderObjects>): Promise<Response> {
  if (request.method === "GET") return readWebAnimationPackage(request, env.BUCKET, ctx.params.packageKey);
  const { response, written } = await storeWebAnimationRenderOutput(request, env.BUCKET, ctx.params);
  if (written !== null) await jobObject(env, ctx).noteWritten(written);
  return response;
}

/**
 * A positive finite number from a report, or null.
 * @param value - The value.
 * @returns It, or null.
 */
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read a measured width and height.
 * @param value - The value.
 * @returns Them, or null.
 */
function measuredSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as Record<string, unknown>;
  const w = positive(width);
  const h = positive(height);
  return w === null || h === null ? null : { width: Math.round(w), height: Math.round(h) };
}

/**
 * Take the runner's progress or its final report.
 * @param request - What the container sent to `jobs.local`.
 * @param env - The bindings.
 * @param ctx - The handler's context.
 * @returns An acknowledgement, or 400 for a body that is neither.
 */
async function jobReport(request: Request, env: WebAnimationRenderEnv, ctx: OutboundHandlerContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body = (request.method === "POST" ? await request.json().catch(() => null) : null) as Record<string, unknown> | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return new Response("Unreadable report", { status: 400 });
  const job = jobObject(env, ctx);
  if (path === WEB_ANIMATION_PROGRESS_PATH) {
    const phase = body.phase === "rendering" || body.phase === "saving" ? body.phase : null;
    const progress = typeof body.progress === "number" ? Math.min(Math.max(body.progress, 0), 1) : null;
    if (phase === null || progress === null) return new Response("Unreadable progress", { status: 400 });
    await job.noteProgress(phase, progress);
    return new Response(null, { status: 200 });
  }
  if (path === WEB_ANIMATION_REPORT_PATH && typeof body.ok === "boolean") {
    const size = measuredSize(body.video);
    const duration = positive((body.video as Record<string, unknown> | null)?.durationSeconds);
    await job.noteFinished({
      ok: body.ok,
      failureReason: typeof body.failureReason === "string" && body.failureReason.length > 0 ? body.failureReason.slice(0, 200) : null,
      cpuUsec: typeof body.cpuUsec === "number" && body.cpuUsec >= 0 ? body.cpuUsec : null,
      video: size === null || duration === null ? null : { ...size, durationSeconds: duration },
      cover: measuredSize(body.cover),
    });
    return new Response(null, { status: 200 });
  }
  return new Response("Unreadable report", { status: 400 });
}

WebAnimationRenderContainer.outboundHandlers = { [JOB_OBJECTS]: jobObjects, [JOB_REPORT]: jobReport };
