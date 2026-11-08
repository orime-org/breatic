// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `timeline` queue's processor (inner#1711 design §3.5, §5.2, §5.3, §6).
 *
 * A pickup takes the row with a new attempt and fence (claim from queued, retry from running) and never moves the
 * original deadline. The container job is fixed once, in the row's steps, before its first submission, so every
 * attempt submits the same job; each pickup reads the job before deciding to submit it. While the job runs the
 * pickup goes back to the queue.
 *
 * Only a terminal report settles: the source version (for a done report whose Manifest matches the accepted input),
 * one usage row per settled model call under `timeline:<executionId>:<seq>` and one for the container, then the
 * `billed_at` gate decides whether this writer charges, then the terminal transition. The job lock is re-checked
 * before each of those four writes, and the terminal transition also needs this attempt's fence, so a writer that
 * lost the job changes nothing more.
 */

import { DelayedError, type Job } from "bullmq";
import {
  getMiniToolsConfig,
  getStorageAdapter,
  getTimelineConfig,
  getWorkerConfig,
  logger,
  timelineExecutionRepo,
  type TimelineExecutionEvent,
  type TimelineExecutionJobData,
} from "@breatic/core";
import {
  containerCostUsd,
  createUsageRecorder,
  creditLotService,
  sumCreditsByOperationKeys,
  timelineOperationKey,
  toChargeCredits,
  webAnimationSourceRepo,
} from "@breatic/domain";
import type { TimelineExecution } from "@breatic/shared";
import {
  TimelineExecutionInputSchema,
  WEB_ANIMATION_CONTAINER_CLASS,
  WEB_ANIMATION_MANIFEST_MAX_BYTES,
  WebAnimationManifestSchema,
  matchWebAnimationManifest,
  webAnimationDurationFrames,
  webAnimationJobRequestSchema,
  type TimelineExecutionInput,
  type WebAnimationJobReport,
  type WebAnimationJobRequest,
  type WebAnimationManifest,
} from "@breatic/shared/space-content";
import { StillRunning } from "@worker/providers/still-running.js";
import { move } from "@worker/handlers/timeline/timeline-transition.js";
import {
  cancelWebAnimationJob,
  readWebAnimationJob,
  submitWebAnimationJob,
  type IngestAnswer,
} from "@worker/handlers/timeline/web-animation-ingest.js";

/** The step that fixes an execution's container job, written before its first submission. */
interface JobStep {
  kind: "container_job";
  /** The job as it is submitted; its `deadlineAt` is the execution's original deadline in epoch ms. */
  request: WebAnimationJobRequest;
}

/** One pickup's view of the execution it holds. */
interface Pickup {
  job: Pick<Job<TimelineExecutionJobData>, "extendLock">;
  token: string | undefined;
  row: TimelineExecution;
  step: JobStep;
  /** When the job's last report is due: two polls past the deadline. */
  endsAt: number;
}

/** One file a report says the job wrote. */
type JobOutput = WebAnimationJobReport["outputs"][number];

/** A done report's outputs and Manifest, checked against the accepted job. */
interface ValidResult {
  manifest: WebAnimationManifest;
  pkg: JobOutput;
  man: JobOutput;
}

/** How a settled run ends: a terminal event, or the result a done report's Manifest makes. */
type RunEnd = TimelineExecutionEvent | ({ type: "result" } & ValidResult);

/** A report that ended; only these settle. */
type EndedReport = WebAnimationJobReport & { state: "done" | "failed" | "cancelled" | "expired" | "cancelled_before_submit" };

const ENDED: ReadonlySet<WebAnimationJobReport["state"]> = new Set(["done", "failed", "cancelled", "expired", "cancelled_before_submit"]);

/**
 * Whether a report ended.
 * @param report - The report.
 * @returns True for a terminal state.
 * @throws {never} Never.
 */
function ended(report: WebAnimationJobReport): report is EndedReport {
  return ENDED.has(report.state);
}

/**
 * Whether this attempt still owns the job. A pickup outside the queue (no token) has no rival.
 * @param pickup - The pickup.
 * @returns True when it may write.
 * @throws {Error} When Redis cannot answer; the job's retry owns that.
 */
async function owns(pickup: Pickup): Promise<boolean> {
  if (pickup.token === undefined) return true;
  if ((await pickup.job.extendLock(pickup.token, getWorkerConfig().lock_duration_ms)) === 1) return true;
  logger.error({ executionId: pickup.row.id, attempt: pickup.row.attempt }, "timeline_job_lock_lost_aborting");
  return false;
}

/**
 * The job step a row already holds. Its request is read back through its schema, which also restores the field
 * order jsonb does not keep, so every attempt submits the same bytes. Anything else a stored step carries beside its
 * request is ignored.
 * @param steps - The row's steps.
 * @returns The step, or undefined when none was written yet.
 * @throws {never} Never.
 */
function storedStep(steps: unknown[]): JobStep | undefined {
  for (const step of steps) {
    const candidate = step as Partial<JobStep> | null;
    if (candidate?.kind !== "container_job") continue;
    const request = webAnimationJobRequestSchema.safeParse(candidate.request);
    if (!request.success) return undefined;
    return { kind: "container_job", request: request.data };
  }
  return undefined;
}

/**
 * The job an execution runs: fixed from its accepted input and the yaml of the attempt that first submits it.
 * @param row - The execution.
 * @param input - Its frozen input.
 * @returns The step.
 * @throws {RangeError} When the input's duration does not make a frame count.
 */
function newStep(row: TimelineExecution, input: TimelineExecutionInput): JobStep {
  const config = getTimelineConfig().web_animation;
  const prefix = `web-animation/${row.projectId}/${row.id}`;
  return {
    kind: "container_job",
    request: {
      containerClass: WEB_ANIMATION_CONTAINER_CLASS,
      jobId: timelineOperationKey(row.id),
      deadlineAt: Date.parse(row.deadlineAt),
      prompt: input.prompt,
      viewport: { ...config.viewports[input.aspect] },
      fps: input.fps,
      durationFrames: webAnimationDurationFrames(input),
      packageKey: `${prefix}/index.html`,
      manifestKey: `${prefix}/manifest.json`,
      fontSetVersion: config.font_set_version,
      maxPackageBytes: config.max_package_bytes,
      maxTokens: config.max_tokens,
      callTimeoutMs: config.call_timeout_ms,
      model: config.model,
    },
  };
}

/**
 * Take the row for this pickup: claim a queued one, retry a running one, keep a cancelling one as it is.
 * @param row - The row as read.
 * @returns The row this pickup holds, or null when there is nothing for it to do.
 * @throws {Error} When a write fails.
 */
async function take(row: TimelineExecution): Promise<TimelineExecution | null> {
  if (row.status === "queued") {
    // Never claimed, so never submitted: past its deadline it ends without a job.
    if (Date.parse(row.deadlineAt) <= Date.now()) {
      await move(row, { type: "deadline" });
      return null;
    }
    const claimed = await move(row, { type: "claim" });
    return claimed.applied ? claimed.row : take(claimed.row);
  }
  if (row.status === "running") {
    // A new attempt changes nothing the user sees, so it does not signal the Space; a phase change does.
    const retried = await timelineExecutionRepo.transition({ id: row.id, event: { type: "retry" } });
    return retried.applied ? retried.row : take(retried.row);
  }
  return row.status === "cancelling" ? row : null;
}

/**
 * End the row as not available on this ingest Worker: settle an empty report and fail it (a cancelling row ends
 * cancelled).
 * @param pickup - The pickup.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function featureDisabled(pickup: Pickup): Promise<void> {
  const empty: EndedReport = { state: "failed", phase: null, steps: [], calls: [], container: null, outputs: [], failureReason: "feature_disabled" };
  await settle(pickup, empty, { type: "failure", fence: pickup.row.fence, reason: "feature_disabled" });
}

/**
 * Read the Manifest a done report wrote and check it, and the outputs, against the accepted job.
 * @param pickup - The pickup.
 * @param report - The done report.
 * @returns The Manifest with the package and Manifest outputs, or why they do not match.
 * @throws {Error} When storage cannot be read.
 */
async function validated(pickup: Pickup, report: EndedReport): Promise<ValidResult | { reason: string }> {
  const { request } = pickup.step;
  const pkg = report.outputs.find((output) => output.key === request.packageKey);
  const man = report.outputs.find((output) => output.key === request.manifestKey);
  if (pkg === undefined || man === undefined) return { reason: "output_missing" };
  if (pkg.bytes > request.maxPackageBytes) return { reason: "package_too_large" };
  const bytes = await (await getStorageAdapter()).read(request.manifestKey, WEB_ANIMATION_MANIFEST_MAX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Not JSON is the same answer as not a Manifest.
    return { reason: "manifest_invalid" };
  }
  const parsed = WebAnimationManifestSchema.safeParse(json);
  if (!parsed.success) return { reason: "manifest_invalid" };
  const mismatch = matchWebAnimationManifest(parsed.data, {
    viewport: request.viewport,
    fps: request.fps,
    durationFrames: request.durationFrames,
    fontSetVersion: request.fontSetVersion,
  });
  return mismatch === null ? { manifest: parsed.data, pkg, man } : { reason: mismatch };
}

/**
 * Record one row per settled model call and one for the container. An upstream error made no generation and
 * writes nothing; a call interrupted or cut off by a crash is recorded at zero and logged for reconciliation.
 * @param pickup - The pickup.
 * @param report - The terminal report.
 * @returns Nothing once every row is written.
 * @throws {Error} When a write fails.
 */
async function recordUsage(pickup: Pickup, report: EndedReport): Promise<void> {
  const { row, step } = pickup;
  const recorder = createUsageRecorder({
    operationKey: timelineOperationKey(row.id),
    feature: "timeline_web_animation",
    actorUserId: row.actorUserId,
    projectId: row.projectId,
    // Every call recorded at zero is logged with its identity below.
    onMissingCost: () => {},
  });
  for (const call of report.calls) {
    if (call.outcome === "upstream_error") continue;
    if (call.costUsd === null) {
      logger.error({ executionId: row.id, seq: call.seq, generationId: call.generationId, outcome: call.outcome }, "timeline_model_call_cost_missing");
    }
    const tokens = call.tokens;
    recorder.recordModelCall({
      source: "model",
      model: step.request.model,
      provider: "openrouter",
      usage: {
        inputTokens: tokens?.input,
        inputTokenDetails: { noCacheTokens: tokens === null ? undefined : tokens.input - tokens.cacheRead, cacheReadTokens: tokens?.cacheRead },
        outputTokens: tokens?.output,
        outputTokenDetails: { reasoningTokens: tokens?.reasoning },
      },
      providerMetadata: call.costUsd === null ? undefined : { openrouter: { usage: { cost: call.costUsd } } },
      // Only a priced call names its generation: one without a cost is recorded at zero, not looked up later.
      ...(call.costUsd !== null && call.generationId !== null && { generationId: call.generationId }),
      costIdentity: `${timelineOperationKey(row.id)}:${call.seq}`,
    });
  }
  if (report.container !== null) {
    const config = getTimelineConfig().web_animation;
    recorder.recordServiceCall({
      source: "container",
      service: "cloudflare-container:web_animation",
      provider: "cloudflare",
      requests: 1,
      costUsd: containerCostUsd(report.container, config.container, getMiniToolsConfig().prices),
      costSource: "computed",
    });
  }
  await recorder.settle();
}

/**
 * Charge what the execution's rows add up to, once: only the writer whose `billed_at` update lands charges, and a run
 * that spent nothing charges nothing. As with an Agent chat turn nothing was held, and the charge may take the balance
 * below zero.
 * @param pickup - The pickup.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function bill(pickup: Pickup): Promise<void> {
  const { row, step } = pickup;
  const sums = await sumCreditsByOperationKeys([timelineOperationKey(row.id)]);
  const amount = toChargeCredits(Number(sums.get(timelineOperationKey(row.id)) ?? 0));
  if (amount <= 0 || !(await timelineExecutionRepo.markBilled(row.id, String(amount)))) return;
  const outcome = await creditLotService.chargeForGeneration({
    projectId: row.projectId,
    actorUserId: row.actorUserId,
    amount,
    description: "timeline_web_animation",
    referenceId: row.id,
    model: step.request.model,
    provider: "openrouter",
  });
  if (Number(outcome.shortfall) > 0) {
    logger.warn({ executionId: row.id, amount, shortfall: outcome.shortfall }, "timeline_charge_shortfall");
  }
}

/**
 * Settle a terminal report and end the row: the source, the usage, the charge and the transition, each behind the
 * job lock.
 * @param pickup - The pickup.
 * @param report - The terminal report.
 * @param end - The terminal event, or the result to record and succeed with.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function settle(pickup: Pickup, report: EndedReport, end: RunEnd): Promise<void> {
  const { row } = pickup;
  let event: TimelineExecutionEvent;
  if (end.type !== "result") {
    event = end;
  } else {
    const { manifest, pkg, man } = end;
    if (!(await owns(pickup))) return;
    const source = await webAnimationSourceRepo.insert({
      executionId: row.id,
      packageKey: pkg.key,
      manifestKey: man.key,
      packageSha256: pkg.sha256,
      packageBytes: pkg.bytes,
      manifestSha256: man.sha256,
      runtimeVersion: `@hyperframes/core@${manifest.runtime.version}`,
      fontSetVersion: manifest.resources[0]!.version,
      width: manifest.viewport.width,
      height: manifest.viewport.height,
      fpsNum: manifest.fps.num,
      fpsDen: manifest.fps.den,
      durationFrames: manifest.durationFrames,
    });
    event = { type: "success", fence: row.fence, resultSourceVersionId: source.id };
  }
  if (!(await owns(pickup))) return;
  await recordUsage(pickup, report);
  if (!(await owns(pickup))) return;
  await bill(pickup);
  if (!(await owns(pickup))) return;
  await move(row, event);
}

/**
 * Settle a terminal report found by a pickup of a running row.
 * @param pickup - The pickup.
 * @param report - The terminal report.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function finish(pickup: Pickup, report: EndedReport): Promise<void> {
  const fence = pickup.row.fence;
  // Two polls past the deadline the run is out of time, whatever its report says.
  if (Date.now() >= pickup.endsAt || report.state === "expired") return settle(pickup, report, { type: "deadline" });
  if (report.state === "done") {
    const checked = await validated(pickup, report);
    return settle(pickup, report, "manifest" in checked ? { type: "result", ...checked } : { type: "failure", fence, reason: checked.reason });
  }
  const reason = report.state === "failed" ? (report.failureReason ?? "container_failed") : "container_cancelled";
  return settle(pickup, report, { type: "failure", fence, reason });
}

/**
 * Note a running job's phase and steps on the row, signalling the Space when the phase changed.
 * @param pickup - The pickup.
 * @param report - The running report.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function noteProgress(pickup: Pickup, report: WebAnimationJobReport): Promise<void> {
  const { row, step } = pickup;
  // The runtime's steps only grow; jsonb does not keep key order, so their count is what is compared.
  if (report.steps.length !== row.steps.length - 1) {
    await timelineExecutionRepo.recordSteps({ id: row.id, fence: row.fence, steps: [step, ...report.steps] });
  }
  if (report.phase !== null && report.phase !== row.phase) await move(row, { type: "progress", fence: row.fence, phase: report.phase });
}

/**
 * Act on a cancel's answer for a cancelling row: a terminal report settles and acknowledges the cancel.
 * @param pickup - The pickup.
 * @returns Nothing.
 * @throws {StillRunning} While the job is still stopping.
 * @throws {Error} When a write fails.
 */
async function cancelling(pickup: Pickup): Promise<void> {
  const answer = await cancelWebAnimationJob(pickup.step.request.jobId, { deadlineAt: pickup.step.request.deadlineAt }, pickup.endsAt);
  if (answer.kind === "disabled") return featureDisabled(pickup);
  if (answer.kind === "report" && ended(answer.report)) return settle(pickup, answer.report, { type: "cancelAck" });
  throw new StillRunning(Date.now() + getTimelineConfig().web_animation.poll_interval_ms);
}

/**
 * Read the job, submitting it when the Worker holds none, and settle it once it ends.
 * @param pickup - The pickup.
 * @returns Nothing.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When a write or a call fails.
 */
async function running(pickup: Pickup): Promise<void> {
  const { step: { request }, endsAt } = pickup;
  const poll = getTimelineConfig().web_animation.poll_interval_ms;
  let answer: IngestAnswer = await readWebAnimationJob(request.jobId, endsAt);
  if (answer.kind === "missing") {
    // The Worker holds no job, so it never ran; past the deadline it is not started.
    if (Date.now() >= request.deadlineAt) {
      if (await owns(pickup)) await move(pickup.row, { type: "deadline" });
      return;
    }
    answer = await submitWebAnimationJob(request, endsAt);
    if (answer.kind === "unavailable") logger.warn({ executionId: pickup.row.id, jobId: request.jobId }, "web_animation_container_start_refused");
  }
  if (answer.kind === "disabled") return featureDisabled(pickup);
  const report = answer.kind === "report" ? answer.report : null;
  if (report !== null && ended(report)) return finish(pickup, report);
  if (Date.now() >= endsAt) {
    // Out of time and still going: stop it, and read its ending on a later pickup.
    const stopped = await cancelWebAnimationJob(request.jobId, { deadlineAt: request.deadlineAt }, endsAt);
    if (stopped.kind === "disabled") return featureDisabled(pickup);
    if (stopped.kind === "report" && ended(stopped.report)) return finish(pickup, stopped.report);
  } else if (report !== null) {
    await noteProgress(pickup, report);
  }
  throw new StillRunning(Date.now() + poll);
}

/**
 * One pickup of an execution.
 * @param job - The job.
 * @param token - This attempt's lock token.
 * @returns Nothing.
 * @throws {StillRunning} While the container job runs.
 * @throws {Error} When a write or a call fails; the job's retry picks it up again.
 */
async function pickUp(job: Job<TimelineExecutionJobData>, token: string | undefined): Promise<void> {
  const read = await timelineExecutionRepo.findById(job.data.executionId);
  if (read === undefined) return;
  const row = await take(read);
  if (row === null) return;
  const input = TimelineExecutionInputSchema.safeParse(row.input);
  if (!input.success) {
    logger.error({ executionId: row.id, issues: input.error.issues }, "timeline_execution_input_unreadable");
    await move(row, { type: "failure", fence: row.fence, reason: "internal" });
    return;
  }
  let step = storedStep(row.steps);
  if (step === undefined) {
    step = newStep(row, input.data);
    if (!(await timelineExecutionRepo.recordSteps({ id: row.id, fence: row.fence, steps: [step, ...row.steps] }))) return;
  }
  const pickup: Pickup = {
    job,
    token,
    row,
    step,
    endsAt: step.request.deadlineAt + 2 * getTimelineConfig().web_animation.poll_interval_ms,
  };
  if (row.status === "cancelling") return cancelling(pickup);
  return running(pickup);
}

/**
 * Process one `timeline` job. While its container job runs, the job goes back to the queue as delayed, spending
 * none of its attempts.
 * @param job - The job.
 * @param token - This attempt's lock token (BullMQ's second processor argument).
 * @returns Nothing once this pickup is done.
 * @throws {DelayedError} When the job went back to the queue.
 * @throws {StillRunning} When it must wait and no token lets it move itself.
 * @throws {Error} When a write or a call fails.
 */
export async function runTimelineExecution(job: Job<TimelineExecutionJobData>, token?: string): Promise<void> {
  try {
    await pickUp(job, token);
  } catch (err) {
    if (err instanceof StillRunning && token !== undefined) {
      await job.moveToDelayed(err.resumeAt, token);
      throw new DelayedError();
    }
    throw err;
  }
}
