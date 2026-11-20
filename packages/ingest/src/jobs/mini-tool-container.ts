// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { miniToolPlanAccess, sameMiniToolPlanJob, readMiniToolPlanJobReport, type MiniToolJobReport, type MiniToolJobRequest, type MiniToolPlanJobRequest, type MiniToolPlanJobReport } from "@breatic/shared";

import { canonicalMiniToolValue } from "@shared/mini-tools/canonical-value.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import { MEDIA_OBJECT_HOST, mediaObjectUrl } from "@ingest/media-object-route.js";
import { readContainerReport, type ContainerReportBody, type MediaOfOutput, type PlanContainerReportBody } from "@ingest/jobs/container-report.js";
import { RUN_PATH } from "@ingest/jobs/op-args.js";
import { PROBE_PORT } from "@ingest/probe-answer.js";
import { transition, type JobEvent, type JobState } from "@ingest/jobs/transition.js";
import { serveJobObjects, type JobObjectAccess } from "@ingest/jobs/job-objects.js";
import { JOB_RECORD_KEY, type JobWritten as Written, type StoredMiniToolJob as JobRecord, type PlannedStartFacts } from "@ingest/jobs/job-record.js";
import { recordJobWrite, claimJobWrite } from "@ingest/jobs/job-write.js";

/** Where the container reports how its run went. */
export const JOB_REPORT_HOST = "jobs.local";

/** What these classes need bound. */
export interface MiniToolEnv {
  BUCKET: R2Bucket;
  MINI_TOOL_STD1: DurableObjectNamespace<MiniToolContainerStd1>;
  MINI_TOOL_STD4: DurableObjectNamespace<MiniToolContainerStd4>;
  MINI_TOOL_GL: DurableObjectNamespace<MiniToolContainerGl>;
}

/** The binding each class is reached through, by class name. */
export const CLASS_BINDINGS = {
  MiniToolContainerStd1: "MINI_TOOL_STD1",
  MiniToolContainerStd4: "MINI_TOOL_STD4",
  MiniToolContainerGl: "MINI_TOOL_GL",
} as const satisfies Record<string, keyof MiniToolEnv>;

/** A class name this Worker binds. */
export type MiniToolClass = keyof typeof CLASS_BINDINGS;

const RECORD = JOB_RECORD_KEY;
/** Initial absence of observations does not assert zero consumption or that a VM never ran. */
const NO_START_FACTS: PlannedStartFacts = { startRequested: false, startResolved: false, runningObserved: false, runDispatchAttempted: false, runAcknowledged: false };

/** The outbound handlers' names. */
const JOB_OBJECTS = "jobObjects";
const JOB_REPORT = "jobReport";

/** A run that could not be started; the route answers 503. */
export class JobStartFailed extends Error {}
/** A repeated identifier whose immutable request differs from its first submission. */
export class JobIdentityConflict extends Error { override name = "JobIdentityConflict"; }

/**
 * Identify a validated versioned request without promoting a legacy payload.
 * @param request - The accepted request.
 * @returns Whether this is the planned protocol lane.
 * @throws {never} Never.
 */
function isPlan(request: MiniToolJobRequest | MiniToolPlanJobRequest): request is MiniToolPlanJobRequest {
  return "schemaVersion" in request && request.schemaVersion === 2;
}

/**
 * Add an attempt capability to a URL emitted only by this object's code.
 * @param url - The internal intercepted URL.
 * @param attemptId - The current immutable attempt.
 * @returns Its attempt-bound URL.
 * @throws {never} Never.
 */
function attemptUrl(url: string, attemptId: string): string {
  return `${url}?attempt=${encodeURIComponent(attemptId)}`;
}

/**
 * The report a job gives.
 * @param record - The job.
 * @returns Its report.
 */
function reportOf(record: JobRecord): MiniToolJobReport | MiniToolPlanJobReport {
  const { state, request } = record;
  const usage =
    state.endedAt === null ? null : { wallMs: state.endedAt - state.startedAt, cpuUsec: record.cpuUsec };
  if (isPlan(request)) {
    if (state.phase === "starting" || state.phase === "running") return { schemaVersion: 2, state: state.phase };
    const outputs = request.outputs.filter((output) => record.written[output.storageKey] !== undefined).map((output) => {
      const written = record.written[output.storageKey]!;
      const media = record.media[output.storageKey];
      const cover = output.coverKey === undefined ? undefined : record.written[output.coverKey];
      return {
        outputIndex: output.outputIndex, storageKey: output.storageKey, ...written,
        width: media?.width ?? null, height: media?.height ?? null, durationSeconds: media?.durationSeconds ?? null,
        upright: null,
        cover: cover === undefined || output.coverKey === undefined ? null : {
          storageKey: output.coverKey, ...cover, width: media?.cover?.width ?? null, height: media?.cover?.height ?? null,
        },
        ...(media?.packing === undefined ? {} : { packing: media.packing }),
      };
    });
    const measured = record.reported === undefined ? null : usage;
    const count = record.reported !== undefined && "count" in record.reported ? record.reported.count : undefined;
    return readMiniToolPlanJobReport(request, state.phase === "done" && measured !== null
      ? { schemaVersion: 2, state: "done", outputs, usage: measured, ...(count === undefined ? {} : { count }) }
      : { schemaVersion: 2, state: "failed", reason: state.reason ?? "tool_failed", outputs, usage: measured });
  }
  if (state.phase === "starting" || state.phase === "running") return { state: state.phase };
  if (state.phase === "failed" || usage === null) return { state: "failed", reason: state.reason ?? "tool_failed", usage };
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
  async submit(request: MiniToolJobRequest | MiniToolPlanJobRequest): Promise<MiniToolJobReport | MiniToolPlanJobReport> {
    const held = await this.load();
    if (held) {
      if ((isPlan(held.request) || isPlan(request)) && (!isPlan(held.request) || !isPlan(request) || !sameMiniToolPlanJob(held.request, request))) {
        throw new JobIdentityConflict("The submitted plan differs from the original job identity");
      }
      return reportOf(held);
    }
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
      const ended: JobRecord = { state: { ...state, phase: "failed", endedAt: now, reason: "expired" }, request, written: {}, media: {}, cpuUsec: null, ...(isPlan(request) ? { startFacts: { ...NO_START_FACTS } } : {}) };
      await this.save(ended);
      return reportOf(ended);
    }
    await this.save({ state, request, written: {}, media: {}, cpuUsec: null, ...(isPlan(request) ? { startFacts: { ...NO_START_FACTS } } : {}) });
    await this.schedule(new Date(request.deadlineAt), "expireJob", { attemptId: state.attemptId });

    const writes: Record<string, string> = {};
    for (const output of request.outputs) {
      writes[output.storageKey] = output.contentType;
      if (output.coverKey !== undefined) writes[output.coverKey] = "image/png";
    }
    const planned = isPlan(request);
    const objects: JobObjectAccess = planned
      ? { ...miniToolPlanAccess(request), attemptId: state.attemptId }
      // A join reads its further clips beside the source (inner#1825 §6.4).
      : { reads: [request.input.storageKey, ...(request.extra ?? []).map((input) => input.storageKey)], writes };
    try {
      await this.setOutboundByHosts({
        [MEDIA_OBJECT_HOST]: { method: JOB_OBJECTS, params: objects },
        [JOB_REPORT_HOST]: planned ? { method: JOB_REPORT, params: objects } : JOB_REPORT,
      });
      if (planned) await this.observeStart({ startRequested: true });
      await this.start();
      if (planned) await this.observeStart({ startResolved: true, runningObserved: this.ctx.container?.running === true, runDispatchAttempted: true });
      const answered = await this.containerFetch(
        new Request(`http://job${RUN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isPlan(request) ? {
            schemaVersion: 2, attemptId: state.attemptId, deadlineAt: request.deadlineAt,
            limits: request.limits,
            inputs: request.inputs.map((input) => ({ inputId: input.inputId, url: attemptUrl(mediaObjectUrl(input.storageKey), state.attemptId) })),
            outputs: request.outputs.map((output) => ({
              outputIndex: output.outputIndex, recipe: output.recipe, contentType: output.contentType,
              key: output.storageKey, url: attemptUrl(mediaObjectUrl(output.storageKey), state.attemptId),
              ...(output.coverKey === undefined ? {} : { coverUrl: attemptUrl(mediaObjectUrl(output.coverKey), state.attemptId) }),
            })),
            ...(request.count === undefined ? {} : { count: request.count }),
            reportUrl: attemptUrl(`http://${JOB_REPORT_HOST}/report`, state.attemptId),
          } : {
            op: request.op,
            params: request.params,
            input: mediaObjectUrl(request.input.storageKey),
            extra: (request.extra ?? []).map((input) => mediaObjectUrl(input.storageKey)),
            outputs: request.outputs.map((output) => ({
              url: mediaObjectUrl(output.storageKey), key: output.storageKey,
              ...(output.coverKey !== undefined && { coverUrl: mediaObjectUrl(output.coverKey) }),
            })),
            reportUrl: `http://${JOB_REPORT_HOST}/report`,
          }),
        }),
      );
      if (answered.status !== 202) throw new JobStartFailed(`the run was answered ${answered.status}`);
      if (planned) await this.observeStart({ runAcknowledged: true });
    } catch (err) {
      if (planned) await this.observeStart({ runningObserved: this.ctx.container?.running === true });
      await this.apply(planned ? { type: "reported", ok: false, reason: "internal" } : { type: "startFailed" });
      throw err instanceof JobStartFailed ? err : new JobStartFailed(String(err));
    }
    const accepted = await this.apply({ type: "accepted" });
    return accepted ? reportOf(accepted) : planned ? { schemaVersion: 2, state: "running" } : { state: "running" };
  }

  /**
   * The job's report, noticing a running job whose container is gone.
   * @returns The report, or null when this object holds no job.
   */
  async report(): Promise<MiniToolJobReport | MiniToolPlanJobReport | null> {
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
   * @param attemptId - The immutable planned attempt that issued the write.
   * @param claimToken - The durable pre-write owner of the output.
   * @returns Nothing.
   */
  async noteWritten(key: string, written: Written, attemptId?: string, claimToken?: string): Promise<void> {
    await recordJobWrite(this.ctx.storage, key, written, attemptId, claimToken);
  }

  /**
   * Claim a planned key before its outbound handler starts any R2 IO.
   * @param key - The declared output key.
   * @param attemptId - The immutable planned attempt.
   * @returns The durable writer token, or null when refused.
   * @throws {Error} When the durable claim transaction fails.
   */
  async claimOutputWrite(key: string, attemptId: string): Promise<string | null> {
    return claimJobWrite(this.ctx.storage, key, attemptId);
  }

  /**
   * The container's report on its run.
   * @param body - What it said.
   * @returns Nothing.
   */
  async noteReported(body: ContainerReportBody | PlanContainerReportBody): Promise<void> {
    const record = await this.load();
    if (!record) return;
    let media: Record<string, MediaOfOutput>;
    if (isPlan(record.request)) {
      if (!("schemaVersion" in body) || body.attemptId !== record.state.attemptId) throw new Error("Unexpected planned report attempt");
      media = {};
      const seen = new Set<number>();
      for (const output of body.outputs) {
        const declared = record.request.outputs.find((item) => item.outputIndex === output.outputIndex);
        if (!declared || declared.storageKey !== output.storageKey || seen.has(output.outputIndex)) throw new Error("Unexpected planned report output identity");
        if (output.cover !== null && declared.coverKey === undefined) throw new Error("Unexpected planned report cover");
        seen.add(output.outputIndex);
        media[output.storageKey] = { width: output.width, height: output.height, durationSeconds: output.durationSeconds, cover: output.cover,
          ...(output.packing === undefined ? {} : { packing: output.packing }) };
      }
      if (body.ok && seen.size !== record.request.outputs.length) throw new Error("Incomplete planned report metadata");
      // A grid count reports its count exactly when it succeeded; no other job reports one (§7.17 grid_count).
      if ((body.count !== undefined) !== (body.ok && record.request.count !== undefined)) throw new Error("Unexpected planned report count");
      if (record.reported !== undefined) {
        if (canonicalMiniToolValue(record.reported) !== canonicalMiniToolValue(body)) throw new Error("Conflicting immutable container report");
        return;
      }
      // A job already answered as ended with unknown usage keeps that answer: a late report never turns it measured.
      if (record.state.phase === "done" || record.state.phase === "failed") return;
    } else {
      if ("schemaVersion" in body) throw new Error("Unexpected versioned report for a legacy job");
      media = body.media;
    }
    await this.save({ ...record, media, cpuUsec: body.cpuUsec, ...(isPlan(record.request) ? { reported: body } : {}) });
    await this.apply({ type: "reported", ok: body.ok, ...(body.reason !== undefined && { reason: body.reason }) });
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
   * Add only positive start observations without resetting claims, identity or terminal state.
   * @param facts - Application facts observed at a durable dispatch boundary.
   * @returns Nothing after the atomic monotonic merge.
   * @throws {Error} When the durable observation cannot be saved.
   */
  private async observeStart(facts: Partial<PlannedStartFacts>): Promise<void> {
    if (!Object.values(facts).some((value) => value === true)) return;
    await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<JobRecord>(RECORD);
      if (!record || !isPlan(record.request)) return;
      const next = { ...NO_START_FACTS, ...record.startFacts };
      for (const key of Object.keys(facts) as (keyof PlannedStartFacts)[]) if (facts[key] === true) next[key] = true;
      await transaction.put(RECORD, { ...record, startFacts: next });
    });
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

/** The standard-4 instance of the GL image (`Dockerfile` with `VARIANT=gl`): a transition's overlap windows (frames-split §5.4). */
export class MiniToolContainerGl extends MiniToolContainer {}

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
 * Read one of the job's inputs, or write one of its outputs.
 * @param request - What the container asked for.
 * @param env - The bindings.
 * @param ctx - The handler's context, carrying the job's keys.
 * @returns The object, a refusal, or the write's acknowledgement.
 */
async function jobObjects(request: Request, env: MiniToolEnv, ctx: OutboundHandlerContext<JobObjectAccess>): Promise<Response> {
  return serveJobObjects(request, env.BUCKET, ctx.params,
    (key, written, attemptId, token) => jobObject(env, ctx).noteWritten(key, written, attemptId, token),
    (key, attemptId) => jobObject(env, ctx).claimOutputWrite(key, attemptId));
}

/**
 * Take the container's report on its run.
 * @param request - The report.
 * @param env - The bindings.
 * @param ctx - The handler's context.
 * @returns An acknowledgement.
 */
async function jobReport(request: Request, env: MiniToolEnv, ctx: OutboundHandlerContext<{ attemptId?: string }>): Promise<Response> {
  if (ctx.params?.attemptId !== undefined && new URL(request.url).searchParams.get("attempt") !== ctx.params.attemptId) return new Response("Not this attempt", { status: 403 });
  const body = readContainerReport(await request.json().catch(() => null));
  if (body === null) return new Response("Unreadable report", { status: 400 });
  await jobObject(env, ctx).noteReported(body);
  return new Response(null, { status: 200 });
}

for (const kind of [MiniToolContainerStd1, MiniToolContainerStd4, MiniToolContainerGl]) {
  kind.outboundHandlers = { [JOB_OBJECTS]: jobObjects, [JOB_REPORT]: jobReport };
}
