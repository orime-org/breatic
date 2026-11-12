// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation container (inner#1711 design §6): one Durable Object per job, named by the job id, holding the
 * job and its model-call registry and driving one container run of the DeepSeek Harness.
 *
 * Every change to the job goes through `transitionWebAnimationJob`, inside `blockConcurrencyWhile`, so two model
 * calls can never both be granted a seq and the stop, the terminal state and the frozen registry land in one write.
 * The container has no internet: its harness reaches the model through `model.local`, writes its two outputs
 * through `r2.local` and reports through `jobs.local`, each answered by an outbound handler here.
 */

import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext, StopParams } from "@cloudflare/containers";
import type { MessagesCallEnd, MessagesPlan } from "@breatic/provider/messages";
import {
  WEB_ANIMATION_MANIFEST_MAX_BYTES,
  type WebAnimationJobReport,
  type WebAnimationJobRequest,
} from "@breatic/shared/space-content";

import { noteFailure } from "@ingest/error-monitoring.js";
import { askedKey } from "@ingest/object-url.js";
import { MEDIA_OBJECT_HOST, mediaObjectUrl } from "@ingest/media-object-route.js";
import { JOB_REPORT_HOST, JobStartFailed } from "@ingest/jobs/mini-tool-container.js";
import { harnessKeyOf } from "@ingest/jobs/harness-keys.js";
import { MODEL_HOST, relayModelCall } from "@ingest/jobs/web-animation-model-relay.js";
import {
  WEB_ANIMATION_PORT,
  WEB_ANIMATION_PROGRESS_PATH,
  WEB_ANIMATION_REPORT_PATH,
  WEB_ANIMATION_RUN_PATH,
  type WebAnimationRunBody,
  type WebAnimationRunPhase,
} from "@ingest/jobs/web-animation-run-body.js";
import {
  reportOfWebAnimationJob,
  transitionWebAnimationJob,
  type WebAnimationJobEvent,
  type WebAnimationJobRecord,
  type WebAnimationTransition,
} from "@ingest/jobs/web-animation-transition.js";
import { hashStoredObject, writeStreamedObject } from "@ingest/stored-object.js";

/**
 * What this class needs bound; the binding is optional, and its absence turns the feature off. The model keys are
 * `HARNESS_` plus each upstream's key variable (`key_env` in `config/provider/upstreams.yaml`), read through
 * `harnessKeyOf`.
 */
export interface WebAnimationEnv {
  BUCKET: R2Bucket;
  WEB_ANIMATION?: DurableObjectNamespace<WebAnimationContainer>;
}

/** What a submit answers. */
export type WebAnimationSubmitAnswer =
  | { kind: "report"; report: WebAnimationJobReport }
  | { kind: "cancelled_before_submit" };

/** One output as the edge measured it. */
export interface WebAnimationOutput {
  key: string;
  sha256: string;
  bytes: number;
}

/** The two keys a job may write and the package's size limit. */
interface JobObjects {
  packageKey: string;
  manifestKey: string;
  maxPackageBytes: number;
}

/**
 * What the model relay is told about its job. `plan` is absent from a container started by a Worker deployed before
 * the plan (inner#1743), whose stored outbound params carry `model` instead.
 */
interface ModelLimits {
  plan?: MessagesPlan;
  maxTokens: number;
  callTimeoutMs: number;
}

const RECORD = "job";

/** Set once the runner took the run; before it, a stopped container is the start failing, not the job. */
const ACCEPTED = "accepted";

/** Each part of an output as it is written to R2; one part holds any package the limits allow. */
const PART_SIZE = 32 * 1024 * 1024;

/** The outbound handlers' names. */
const MODEL_CALL = "modelCall";
const JOB_OBJECTS = "jobObjects";
const JOB_REPORT = "jobReport";

const PHASES: readonly WebAnimationRunPhase[] = ["writing", "validating", "saving"];

/**
 * Store one of a job's two outputs, as `application/octet-stream` whatever the container claims, so no R2 read
 * serves generated HTML as a page; the preview route alone answers it as `text/html`.
 * @param request - The container's request on `r2.local`.
 * @param bucket - The R2 binding.
 * @param job - The job's two keys and its package limit.
 * @returns The answer for the container, and what was stored when something was.
 * @throws {Error} When R2 refuses the write.
 */
export async function storeWebAnimationOutput(
  request: Request,
  bucket: R2Bucket,
  job: JobObjects,
): Promise<{ response: Response; written: WebAnimationOutput | null }> {
  if (request.method !== "PUT") return { response: new Response("Not allowed", { status: 405 }), written: null };
  const key = askedKey(request);
  if (key !== job.packageKey && key !== job.manifestKey) {
    return { response: new Response("Not this object", { status: 403 }), written: null };
  }
  if (request.body === null) return { response: new Response("No body", { status: 400 }), written: null };
  const stored = await writeStreamedObject(bucket, key, request.body, {
    contentType: "application/octet-stream",
    partSize: PART_SIZE,
    maxBytes: key === job.packageKey ? job.maxPackageBytes : WEB_ANIMATION_MANIFEST_MAX_BYTES,
  });
  if (stored === "over_cap") return { response: new Response("Too large", { status: 413 }), written: null };
  const written = { key, sha256: await hashStoredObject(bucket, key), bytes: stored.sizeBytes };
  return { response: new Response(null, { status: 200 }), written };
}

/** One web-animation job and its container. */
export class WebAnimationContainer extends Container<WebAnimationEnv> {
  defaultPort = WEB_ANIMATION_PORT;

  /** No route out but the handlers below. */
  enableInternet = false;

  /** Carries that refusal to HTTPS as well. */
  interceptHttps = true;

  /**
   * Start a job, or answer the one this object already holds.
   * @param request - The job.
   * @returns Its report, or that a cancel came first.
   * @throws {JobStartFailed} When the container could not be started or would not take the run.
   */
  async submit(request: WebAnimationJobRequest): Promise<WebAnimationSubmitAnswer> {
    const next = await this.apply({ type: "submit", request });
    if (next.refused) return { kind: "cancelled_before_submit" };
    if (next.effects.includes("start")) await this.startRun(request);
    return { kind: "report", report: reportOfWebAnimationJob((await this.load()) ?? next.record)! };
  }

  /**
   * The job's report, noticing a live job whose container is gone.
   * @returns The report, or null when this object holds no job.
   */
  async report(): Promise<WebAnimationJobReport | null> {
    let record = await this.load();
    const live = record?.state === "running" || record?.state === "stopping";
    if (live && (await this.ctx.storage.get<boolean>(ACCEPTED)) === true && this.ctx.container?.running !== true) {
      record = (await this.apply({ type: "containerGone" })).record;
    }
    return reportOfWebAnimationJob(record);
  }

  /**
   * Cancel the job; with none yet, keep a marker refusing its submit until `deadlineAt`.
   * @param deadlineAt - The job's deadline, epoch ms.
   * @returns The report after the cancel.
   */
  async cancel(deadlineAt: number): Promise<WebAnimationJobReport> {
    const next = await this.apply({ type: "cancel", deadlineAt });
    if (next.record?.state === "cancelled_before_submit") {
      if (deadlineAt > Date.now()) await this.schedule(new Date(deadlineAt), "expireMarker");
      else await this.ctx.storage.delete(RECORD);
    }
    return reportOfWebAnimationJob(next.record)!;
  }

  /**
   * Register a model call before it is sent.
   * @returns Its seq, or null when the job takes no call now.
   */
  async beginModelCall(): Promise<number | null> {
    return (await this.apply({ type: "beginModelCall" })).seq;
  }

  /**
   * Record who serves a call and the message its stream started.
   * @param seq - The call.
   * @param upstream - The upstream serving it.
   * @param messageId - The id from `message_start`.
   * @returns Nothing.
   */
  async recordModelCallStart(seq: number, upstream: string, messageId: string): Promise<void> {
    await this.apply({ type: "recordModelCallStart", seq, upstream, messageId });
  }

  /**
   * End a call, and the job with it when the job was waiting for that call to stop.
   * @param seq - The call.
   * @param end - How it ended.
   * @returns Nothing.
   */
  async endModelCall(seq: number, end: MessagesCallEnd): Promise<void> {
    await this.apply({ type: "endModelCall", seq, ...end });
  }

  /**
   * One output the container wrote.
   * @param output - What the edge measured.
   * @returns Nothing.
   */
  async noteWritten(output: WebAnimationOutput): Promise<void> {
    await this.apply({ type: "written", ...output });
  }

  /**
   * The runner's phase and steps.
   * @param phase - The phase.
   * @param steps - Its tool calls and checks so far.
   * @returns Nothing.
   */
  async noteProgress(phase: WebAnimationRunPhase, steps: unknown[]): Promise<void> {
    await this.apply({ type: "progress", phase, steps });
  }

  /**
   * The runner's final report.
   * @param ok - Whether it wrote a package that passed its checks.
   * @param failureReason - Why not.
   * @param cpuUsec - The CPU time its cgroup counted.
   * @returns Nothing.
   */
  async noteFinished(ok: boolean, failureReason: string | null, cpuUsec: number | null): Promise<void> {
    await this.apply({ type: "finished", ok, failureReason, cpuUsec });
  }

  /**
   * The job's deadline.
   * @returns Nothing.
   */
  async expireJob(): Promise<void> {
    await this.apply({ type: "deadline" });
  }

  /**
   * A stopping job whose open call never ended within its limit: its end is lost, so the call is cut off.
   * @returns Nothing.
   */
  async drainJob(): Promise<void> {
    await this.apply({ type: "containerGone" });
  }

  /**
   * Drop the pre-submit cancel marker once its deadline has passed.
   * @returns Nothing.
   */
  async expireMarker(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.load();
      if (record?.state === "cancelled_before_submit" && Date.now() >= (record.markerUntil ?? 0)) {
        await this.ctx.storage.delete(RECORD);
      }
    });
  }

  /**
   * The container stopped.
   * @param _params - How it stopped.
   * @returns Nothing.
   */
  override async onStop(_params: StopParams): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(ACCEPTED)) === true) await this.apply({ type: "containerGone" });
  }

  /**
   * The container failed outside a request.
   * @param error - What went wrong.
   * @returns Nothing.
   */
  override async onError(error: unknown): Promise<void> {
    noteFailure("ingest_web_animation_container_error", { containerId: this.ctx.id.toString() }, error);
    if ((await this.ctx.storage.get<boolean>(ACCEPTED)) === true) await this.apply({ type: "containerGone" });
  }

  /**
   * Keep a live job's container: the harness makes no request into it while it works.
   * @returns Nothing.
   */
  override async onActivityExpired(): Promise<void> {
    const record = await this.load();
    if (record?.state === "running" || record?.state === "stopping") return;
    await this.destroy();
  }

  /**
   * Start the container and hand it the run.
   * @param request - The job.
   * @returns Nothing.
   * @throws {JobStartFailed} When the container could not be started or would not take the run.
   */
  private async startRun(request: WebAnimationJobRequest): Promise<void> {
    await this.schedule(new Date(request.deadlineAt), "expireJob");
    const objects: JobObjects = {
      packageKey: request.packageKey, manifestKey: request.manifestKey, maxPackageBytes: request.maxPackageBytes,
    };
    // The routes submit only a request with a plan; its prices are as provider's messagesPlan wrote them.
    const limits: ModelLimits = { plan: request.messagesPlan as MessagesPlan, maxTokens: request.maxTokens, callTimeoutMs: request.callTimeoutMs };
    const run: WebAnimationRunBody = {
      prompt: request.prompt,
      viewport: request.viewport,
      fps: request.fps,
      durationFrames: request.durationFrames,
      fontSetVersion: request.fontSetVersion,
      maxPackageBytes: request.maxPackageBytes,
      packageUrl: mediaObjectUrl(request.packageKey),
      manifestUrl: mediaObjectUrl(request.manifestKey),
      progressUrl: `http://${JOB_REPORT_HOST}${WEB_ANIMATION_PROGRESS_PATH}`,
      reportUrl: `http://${JOB_REPORT_HOST}${WEB_ANIMATION_REPORT_PATH}`,
    };
    try {
      await this.setOutboundByHosts<unknown>({
        [MODEL_HOST]: { method: MODEL_CALL, params: limits },
        [MEDIA_OBJECT_HOST]: { method: JOB_OBJECTS, params: objects },
        [JOB_REPORT_HOST]: JOB_REPORT,
      });
      await this.start();
      const answered = await this.containerFetch(
        new Request(`http://job${WEB_ANIMATION_RUN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(run),
        }),
      );
      if (answered.status !== 202) throw new JobStartFailed(`the run was answered ${answered.status}`);
    } catch (err) {
      this.deleteSchedules("expireJob");
      await this.apply({ type: "startFailed" });
      throw err instanceof JobStartFailed ? err : new JobStartFailed(String(err));
    }
    await this.ctx.storage.put(ACCEPTED, true);
  }

  /**
   * Apply one event in one serialized read-transition-write, then carry out its effects.
   * @param event - What happened.
   * @returns The transition.
   */
  private async apply(event: WebAnimationJobEvent): Promise<WebAnimationTransition> {
    const next = await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.load();
      const result = transitionWebAnimationJob(record, event, Date.now());
      if (result.record === null) {
        if (record !== null) await this.ctx.storage.delete([RECORD, ACCEPTED]);
      } else if (result.record !== record) {
        await this.ctx.storage.put(RECORD, result.record);
      }
      return result;
    });
    const callTimeoutMs = next.record?.request?.callTimeoutMs;
    if (next.effects.includes("scheduleDrain") && callTimeoutMs !== undefined) {
      // ponytail: twice the call limit, so a call begun just before the stop ends on its own first; a lost end is
      // cut off after that.
      await this.schedule(new Date(Date.now() + 2 * callTimeoutMs), "drainJob");
    }
    if (next.effects.includes("destroy")) {
      this.deleteSchedules("expireJob");
      this.deleteSchedules("drainJob");
      await this.destroy().catch(() => undefined);
    }
    return next;
  }

  /**
   * The stored job.
   * @returns It, or null.
   */
  private async load(): Promise<WebAnimationJobRecord | null> {
    return (await this.ctx.storage.get<WebAnimationJobRecord>(RECORD)) ?? null;
  }
}

/**
 * The job object an outbound handler answers for.
 * @param env - The bindings.
 * @param ctx - The handler's context, naming the object.
 * @returns The object's stub.
 * @throws {Error} When the binding is gone, which cannot happen while one of its containers runs.
 */
function jobObject(env: WebAnimationEnv, ctx: OutboundHandlerContext<unknown>): DurableObjectStub<WebAnimationContainer> {
  const namespace = env.WEB_ANIMATION;
  if (namespace === undefined) throw new Error("WEB_ANIMATION is not bound");
  return namespace.get(namespace.idFromString(ctx.containerId));
}

/**
 * Relay one model call along the job's plan under its limits.
 * @param request - What the harness sent to `model.local`.
 * @param env - The bindings, holding the keys.
 * @param ctx - The handler's context, carrying the job's plan and limits.
 * @returns The relayed answer, or 503 when the job object could not be reached or the container was started without a
 *   plan, which no call is registered for.
 */
async function modelCall(request: Request, env: WebAnimationEnv, ctx: OutboundHandlerContext<ModelLimits>): Promise<Response> {
  const plan = ctx.params.plan;
  if (plan === undefined) return new Response("The job was started without a model plan", { status: 503 });
  const job = jobObject(env, ctx);
  try {
    return await relayModelCall(request, {
      plan,
      keyOf: harnessKeyOf(env),
      maxTokens: ctx.params.maxTokens,
      callTimeoutMs: ctx.params.callTimeoutMs,
      registry: {
        beginModelCall: () => job.beginModelCall(),
        recordModelCallStart: (seq, upstream, messageId) => job.recordModelCallStart(seq, upstream, messageId),
        endModelCall: (seq, end) => job.endModelCall(seq, end),
      },
    });
  } catch (err) {
    noteFailure("ingest_web_animation_model_relay_failed", { containerId: ctx.containerId }, err);
    return new Response("The job could not be reached", { status: 503 });
  }
}

/**
 * Write one of the job's two outputs.
 * @param request - What the container sent to `r2.local`.
 * @param env - The bindings.
 * @param ctx - The handler's context, carrying the job's keys.
 * @returns The write's answer.
 */
async function jobObjects(request: Request, env: WebAnimationEnv, ctx: OutboundHandlerContext<JobObjects>): Promise<Response> {
  const { response, written } = await storeWebAnimationOutput(request, env.BUCKET, ctx.params);
  if (written !== null) await jobObject(env, ctx).noteWritten(written);
  return response;
}

/**
 * Whether a value is a JSON object.
 * @param value - The value.
 * @returns True for a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Take the runner's progress or its final report.
 * @param request - What the container sent to `jobs.local`.
 * @param env - The bindings.
 * @param ctx - The handler's context.
 * @returns An acknowledgement, or 400 for a body that is neither.
 */
async function jobReport(request: Request, env: WebAnimationEnv, ctx: OutboundHandlerContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body: unknown = request.method === "POST" ? await request.json().catch(() => null) : null;
  if (!isObject(body)) return new Response("Unreadable report", { status: 400 });
  const job = jobObject(env, ctx);
  if (path === WEB_ANIMATION_PROGRESS_PATH) {
    const phase = PHASES.find((known) => known === body["phase"]);
    if (phase === undefined || !Array.isArray(body["steps"])) return new Response("Unreadable progress", { status: 400 });
    await job.noteProgress(phase, body["steps"]);
    return new Response(null, { status: 200 });
  }
  if (path === WEB_ANIMATION_REPORT_PATH && typeof body["ok"] === "boolean") {
    const reason = body["failureReason"];
    const cpu = body["cpuUsec"];
    await job.noteFinished(
      body["ok"],
      typeof reason === "string" && reason.length > 0 ? reason.slice(0, 200) : null,
      typeof cpu === "number" && cpu >= 0 ? cpu : null,
    );
    return new Response(null, { status: 200 });
  }
  return new Response("Unreadable report", { status: 400 });
}

WebAnimationContainer.outboundHandlers = { [MODEL_CALL]: modelCall, [JOB_OBJECTS]: jobObjects, [JOB_REPORT]: jobReport };
