// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mini-tool container (inner#888 §8): one Durable Object per job, named
 * by the job id, holding the job's state and driving one container run.
 *
 * Every change to the job goes through `transition()`; what the object does
 * to the container as a result comes back as effects. The container reads its
 * source and writes its outputs through this Worker's outbound handlers, which
 * only ever pass the keys the job named, and reports how it went the same way.
 *
 * One class per instance size, because a container's size is fixed by the
 * class it is bound under.
 */

import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext, StopParams } from "@cloudflare/containers";
import type { IngestMeasurements, MiniToolJobReport, MiniToolJobRequest } from "@breatic/shared";

import { noteFailure } from "@ingest/error-monitoring.js";
import { MEDIA_OBJECT_HOST, mediaObjectUrl, serveOneObject } from "@ingest/media-object-route.js";
import { RUN_PATH } from "@ingest/jobs/op-args.js";
import { PROBE_PORT } from "@ingest/probe-answer.js";
import { transition, type JobEvent, type JobState } from "@ingest/jobs/transition.js";
import { hashStoredObject, sniffStoredObject, writeStreamAsParts } from "@ingest/stored-object.js";

/** Where the container reports how its run went. */
export const JOB_REPORT_HOST = "jobs.local";

/** Each part of an output as it is written to R2. */
const PART_SIZE = 32 * 1024 * 1024;

/** The most parts one output may take: 20 GiB at the size above. */
const MAX_PARTS = 640;

/** What these classes need bound. */
export interface MiniToolEnv {
  BUCKET: R2Bucket;
  MINI_TOOL_STD1: DurableObjectNamespace<MiniToolContainerStd1>;
  MINI_TOOL_STD4: DurableObjectNamespace<MiniToolContainerStd4>;
}

/** The binding each class is reached through, by class name. */
export const CLASS_BINDINGS = {
  MiniToolContainerStd1: "MINI_TOOL_STD1",
  MiniToolContainerStd4: "MINI_TOOL_STD4",
} as const satisfies Record<string, keyof MiniToolEnv>;

/** A class name this Worker binds. */
export type MiniToolClass = keyof typeof CLASS_BINDINGS;

/** What the edge measured about one written object. */
type Written = Pick<IngestMeasurements, "sha256" | "sizeBytes" | "contentType">;

/** The numbers ffprobe read inside the container, per main output. */
interface MediaOfOutput {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  cover: { width: number | null; height: number | null } | null;
}

/** What the container reports. */
export interface ContainerReportBody {
  ok: boolean;
  cpuUsec: number | null;
  media: Record<string, MediaOfOutput>;
}

/** One job as the object stores it. */
interface JobRecord {
  state: JobState;
  request: MiniToolJobRequest;
  written: Record<string, Written>;
  media: Record<string, MediaOfOutput>;
  cpuUsec: number | null;
}

/** What one outbound handler is told about its job. */
interface JobObjects {
  read: string;
  writes: Record<string, string>;
}

const RECORD = "job";

/** The outbound handlers' names. */
const JOB_OBJECTS = "jobObjects";
const JOB_REPORT = "jobReport";

/** A run that could not be started; the route answers 503. */
export class JobStartFailed extends Error {}

/**
 * The report a job gives.
 * @param record - The job.
 * @returns Its report.
 */
function reportOf(record: JobRecord): MiniToolJobReport {
  const { state, request } = record;
  const usage =
    state.endedAt === null ? null : { wallMs: state.endedAt - state.startedAt, cpuUsec: record.cpuUsec };
  if (state.phase === "starting" || state.phase === "running") return { state: state.phase };
  if (state.phase === "failed" || usage === null) return { state: "failed", reason: "tool_failed", usage };
  return {
    state: "done",
    usage,
    outputs: request.outputs.map((output) => {
      const written = record.written[output.storageKey]!;
      const media = record.media[output.storageKey];
      const cover = output.coverKey === undefined ? undefined : record.written[output.coverKey];
      return {
        storageKey: output.storageKey,
        ...written,
        width: media?.width ?? null,
        height: media?.height ?? null,
        durationSeconds: media?.durationSeconds ?? null,
        cover:
          cover === undefined || output.coverKey === undefined
            ? null
            : { storageKey: output.coverKey, ...cover, width: media?.cover?.width ?? null, height: media?.cover?.height ?? null },
      };
    }),
  };
}

/**
 * The shared behaviour of every size's class.
 */
abstract class MiniToolContainer extends Container<MiniToolEnv> {
  defaultPort = PROBE_PORT;

  /** No route out but the handlers below. */
  enableInternet = false;

  /** Carries that refusal to HTTPS as well. */
  interceptHttps = true;

  /**
   * Start a job, or answer the one this object already holds.
   * @param request - The job.
   * @returns Its report.
   * @throws {JobStartFailed} When the container could not be started or would not take the run.
   */
  async submit(request: MiniToolJobRequest): Promise<MiniToolJobReport> {
    const held = await this.load();
    if (held) return reportOf(held);
    const now = Date.now();
    const state: JobState = {
      phase: "starting",
      attemptId: crypto.randomUUID(),
      outputs: request.outputs.map((output) => output.storageKey),
      written: [],
      startedAt: now,
      endedAt: null,
      reason: null,
    };
    if (now >= request.deadlineAt) {
      const ended: JobRecord = { state: { ...state, phase: "failed", endedAt: now, reason: "tool_failed" }, request, written: {}, media: {}, cpuUsec: null };
      await this.save(ended);
      return reportOf(ended);
    }
    await this.save({ state, request, written: {}, media: {}, cpuUsec: null });
    await this.schedule(new Date(request.deadlineAt), "expireJob", { attemptId: state.attemptId });

    const writes: Record<string, string> = {};
    for (const output of request.outputs) {
      writes[output.storageKey] = output.contentType;
      if (output.coverKey !== undefined) writes[output.coverKey] = "image/png";
    }
    const objects: JobObjects = { read: request.input.storageKey, writes };
    try {
      await this.setOutboundByHosts({
        [MEDIA_OBJECT_HOST]: { method: JOB_OBJECTS, params: objects },
        [JOB_REPORT_HOST]: JOB_REPORT,
      });
      await this.start();
      const answered = await this.containerFetch(
        new Request(`http://job${RUN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: request.op,
            params: request.params,
            input: mediaObjectUrl(request.input.storageKey),
            outputs: request.outputs.map((output) => ({
              url: mediaObjectUrl(output.storageKey),
              key: output.storageKey,
              ...(output.coverKey !== undefined && { coverUrl: mediaObjectUrl(output.coverKey) }),
            })),
            reportUrl: `http://${JOB_REPORT_HOST}/report`,
            toolTimeoutMs: request.limits.toolTimeoutMs,
          }),
        }),
      );
      if (answered.status !== 202) throw new JobStartFailed(`the run was answered ${answered.status}`);
    } catch (err) {
      await this.apply({ type: "startFailed" });
      throw err instanceof JobStartFailed ? err : new JobStartFailed(String(err));
    }
    const accepted = await this.apply({ type: "accepted" });
    return accepted ? reportOf(accepted) : { state: "running" };
  }

  /**
   * The job's report, noticing a running job whose container is gone.
   * @returns The report, or null when this object holds no job.
   */
  async report(): Promise<MiniToolJobReport | null> {
    let record = await this.load();
    if (record?.state.phase === "running" && this.ctx.container?.running !== true) {
      record = await this.apply({ type: "containerGone" });
    }
    return record ? reportOf(record) : null;
  }

  /**
   * One object the container wrote.
   * @param key - Its storage key.
   * @param written - What the edge measured.
   * @returns Nothing.
   */
  async noteWritten(key: string, written: Written): Promise<void> {
    const record = await this.load();
    if (!record) return;
    await this.save({ ...record, written: { ...record.written, [key]: written } });
    await this.apply({ type: "written", key });
  }

  /**
   * The container's report on its run.
   * @param body - What it said.
   * @returns Nothing.
   */
  async noteReported(body: ContainerReportBody): Promise<void> {
    const record = await this.load();
    if (!record) return;
    await this.save({ ...record, media: body.media, cpuUsec: body.cpuUsec });
    await this.apply({ type: "reported", ok: body.ok });
  }

  /**
   * The job's deadline.
   * @param payload - Which start the deadline was set for.
   * @param payload.attemptId - That start.
   * @returns Nothing.
   */
  async expireJob(payload: { attemptId: string }): Promise<void> {
    await this.apply({ type: "expired", attemptId: payload.attemptId });
  }

  /**
   * The container stopped.
   * @param _params - How it stopped.
   * @returns Nothing.
   */
  override async onStop(_params: StopParams): Promise<void> {
    await this.apply({ type: "stopped" });
  }

  /**
   * The container failed outside a request.
   * @param error - What went wrong.
   * @returns Nothing.
   */
  override async onError(error: unknown): Promise<void> {
    noteFailure("ingest_mini_tool_container_error", { containerId: this.ctx.id.toString() }, error);
    await this.apply({ type: "stopped" });
  }

  /**
   * Keep a running job's container: the library would stop it once no request
   * has been in flight for a while, and a run makes none while ffmpeg works.
   * @returns Nothing.
   */
  override async onActivityExpired(): Promise<void> {
    const record = await this.load();
    if (record?.state.phase === "running" || record?.state.phase === "starting") return;
    await this.destroy();
  }

  /**
   * Apply one event and carry out its effects.
   * @param event - What happened.
   * @returns The job after it.
   */
  private async apply(event: JobEvent): Promise<JobRecord | null> {
    const record = await this.load();
    const next = transition(record?.state ?? null, event, Date.now());
    if (next.state === null) await this.ctx.storage.delete(RECORD);
    else if (record) await this.save({ ...record, state: next.state });
    for (const effect of next.effects) {
      if (effect === "destroy") await this.destroy().catch(() => undefined);
      if (effect === "cancelSchedule") this.deleteSchedules("expireJob");
      if (effect === "clearOverrides") await this.setOutboundByHosts({});
    }
    return next.state === null || !record ? null : { ...record, state: next.state };
  }

  /**
   * The stored job.
   * @returns It, or null.
   */
  private async load(): Promise<JobRecord | null> {
    return (await this.ctx.storage.get<JobRecord>(RECORD)) ?? null;
  }

  /**
   * Store the job.
   * @param record - The job.
   * @returns Nothing.
   */
  private async save(record: JobRecord): Promise<void> {
    await this.ctx.storage.put(RECORD, record);
  }
}

/** The standard-1 instance. */
export class MiniToolContainerStd1 extends MiniToolContainer {}

/** The standard-4 instance. */
export class MiniToolContainerStd4 extends MiniToolContainer {}

/**
 * The job object an outbound handler answers for.
 * @param env - The bindings.
 * @param ctx - The handler's context, naming the class and the object.
 * @returns The object's stub.
 */
function jobObject(env: MiniToolEnv, ctx: OutboundHandlerContext): DurableObjectStub<MiniToolContainer> {
  const binding = CLASS_BINDINGS[ctx.className as MiniToolClass];
  const namespace = env[binding] as unknown as DurableObjectNamespace<MiniToolContainer>;
  return namespace.get(namespace.idFromString(ctx.containerId));
}

/**
 * Read the job's source, or write one of its outputs.
 * @param request - What the container asked for.
 * @param env - The bindings.
 * @param ctx - The handler's context, carrying the job's keys.
 * @returns The object, a refusal, or the write's acknowledgement.
 */
async function jobObjects(request: Request, env: MiniToolEnv, ctx: OutboundHandlerContext<JobObjects>): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") return serveOneObject(request, env.BUCKET, ctx.params.read);
  if (request.method !== "PUT" || request.body === null) return new Response("Not allowed", { status: 405 });
  const key = decodeURIComponent(new URL(request.url).pathname).slice(1);
  const contentType = ctx.params.writes[key];
  if (contentType === undefined) return new Response("Not this object", { status: 403 });

  const created = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } });
  const parts = await writeStreamAsParts(env.BUCKET, key, created.uploadId, request.body, PART_SIZE, MAX_PARTS);
  if (parts === "over_cap") {
    await created.abort();
    return new Response("Too large", { status: 413 });
  }
  const stored = await created.complete(parts);
  const written: Written = {
    sha256: await hashStoredObject(env.BUCKET, key),
    sizeBytes: stored.size,
    contentType: await sniffStoredObject(env.BUCKET, key),
  };
  await jobObject(env, ctx).noteWritten(key, written);
  return new Response(null, { status: 200 });
}

/**
 * Take the container's report on its run.
 * @param request - The report.
 * @param env - The bindings.
 * @param ctx - The handler's context.
 * @returns An acknowledgement.
 */
async function jobReport(request: Request, env: MiniToolEnv, ctx: OutboundHandlerContext): Promise<Response> {
  const body = await request.json<ContainerReportBody>().catch(() => null);
  if (body === null || typeof body.ok !== "boolean") return new Response("Unreadable report", { status: 400 });
  await jobObject(env, ctx).noteReported({ ok: body.ok, cpuUsec: body.cpuUsec ?? null, media: body.media ?? {} });
  return new Response(null, { status: 200 });
}

for (const kind of [MiniToolContainerStd1, MiniToolContainerStd4]) {
  kind.outboundHandlers = { [JOB_OBJECTS]: jobObjects, [JOB_REPORT]: jobReport };
}
