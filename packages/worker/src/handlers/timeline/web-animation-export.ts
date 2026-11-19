// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An export's pickup (#1490 design §6): render the source package to video on the render container class.
 *
 * The render job is fixed once, in the row's steps, from the frozen frame and length, the source version's package and
 * font set and the video key acceptance minted. While it runs the row shows its phase. A done report carries the video
 * and its cover as the ingest Worker measured them; registration files them as one studio asset, and the row succeeds
 * with it. Only the container's use is recorded: an export calls no model. The job lock is re-checked before the usage,
 * the charge and the terminal transition, as for a creation job.
 */

import { coverKeyFor, getMiniToolsConfig, getTimelineConfig, logger, NotFoundError, timelineExecutionRepo, type TimelineExecutionEvent } from "@breatic/core";
import { containerCostUsd, createUsageRecorder, ingestReportService, timelineOperationKey, webAnimationSourceRepo } from "@breatic/domain";
import type { TimelineExecution } from "@breatic/shared";
import {
  WEB_ANIMATION_RENDER_CONTAINER_CLASS,
  webAnimationRenderJobRequestSchema,
  type WebAnimationExecutionInput,
  type WebAnimationRenderJobReport,
  type WebAnimationRenderJobRequest,
} from "@breatic/shared/space-content";
import { StillRunning } from "@worker/handlers/still-running.js";
import { move } from "@worker/handlers/timeline/timeline-transition.js";
import { cancelRenderJob, readRenderJob, submitRenderJob, type IngestAnswer } from "@worker/handlers/timeline/web-animation-ingest.js";
import { chargeExecution, ended, endsAtOf, owns, storedStep, type Ended, type Held } from "@worker/handlers/timeline/web-animation-pickup.js";

/** The service an export's container use is recorded and charged under. */
const RENDER_SERVICE = "cloudflare-container:web_animation_render";

/** The step that fixes an export's render job, written before its first submission. */
interface RenderStep {
  kind: "render_job";
  request: WebAnimationRenderJobRequest;
}

/** One pickup of an export. */
interface RenderPickup extends Held {
  step: RenderStep;
  /** When the job's last report is due: two polls past the deadline. */
  endsAt: number;
}

/** A render report that ended; only these settle. */
type EndedRender = Ended<WebAnimationRenderJobReport>;

/** An ended report that carries nothing, for a job the Worker cannot run. */
const DISABLED: EndedRender = { state: "failed", phase: null, container: null, video: null, failureReason: "feature_disabled" };

/**
 * The render job an export runs, fixed from its frozen input and its source version.
 * @param row - The export.
 * @param input - Its frozen input.
 * @returns The step.
 * @throws {Error} When the source version is gone.
 */
async function newStep(row: TimelineExecution, input: Extract<WebAnimationExecutionInput, { kind: "web_animation_export" }>): Promise<RenderStep> {
  const source = await webAnimationSourceRepo.findById(input.sourceVersionId);
  if (source === undefined) throw new Error(`Source version ${input.sourceVersionId} is gone`);
  return {
    kind: "render_job",
    request: webAnimationRenderJobRequestSchema.parse({
      containerClass: WEB_ANIMATION_RENDER_CONTAINER_CLASS,
      jobId: timelineOperationKey(row.id),
      deadlineAt: Date.parse(row.deadlineAt),
      packageKey: source.packageKey,
      fontSetVersion: source.fontSetVersion,
      width: input.width,
      height: input.height,
      fps: input.fps,
      durationFrames: input.durationFrames,
      quality: getTimelineConfig().web_animation.render_quality,
      videoKey: input.videoKey,
      coverKey: coverKeyFor(input.videoKey),
    }),
  };
}

/**
 * Record the container's use, the only thing an export spends.
 * @param pickup - The pickup.
 * @param report - The terminal report.
 * @returns Nothing once the row is written.
 * @throws {Error} When the write fails.
 */
async function recordUsage(pickup: RenderPickup, report: EndedRender): Promise<void> {
  if (report.container === null) return;
  const { row } = pickup;
  const recorder = createUsageRecorder({
    operationKey: timelineOperationKey(row.id),
    feature: "timeline_web_animation",
    actorUserId: row.actorUserId,
    projectId: row.projectId,
    onMissingCost: () => {},
  });
  recorder.recordServiceCall({
    source: "container",
    service: RENDER_SERVICE,
    provider: "cloudflare",
    requests: 1,
    costUsd: containerCostUsd(report.container, getTimelineConfig().web_animation.render_container, getMiniToolsConfig().prices),
    costSource: "computed",
  });
  await recorder.settle();
}

/**
 * Settle a terminal report: the usage, the charge and the transition, each behind the job lock.
 * @param pickup - The pickup.
 * @param report - The terminal report.
 * @param event - How the row ends.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function settle(pickup: RenderPickup, report: EndedRender, event: TimelineExecutionEvent): Promise<void> {
  if (!(await owns(pickup))) return;
  await recordUsage(pickup, report);
  if (!(await owns(pickup))) return;
  await chargeExecution(pickup.row, { model: RENDER_SERVICE, provider: "cloudflare" });
  if (!(await owns(pickup))) return;
  await move(pickup.row, event);
}

/**
 * File a done render's video and cover as one studio asset, through the grant acceptance opened.
 * @param pickup - The pickup.
 * @param report - The done report.
 * @returns The success with the asset, or the failure when it was not filed.
 * @throws {Error} When registration fails for a reason a retry may clear.
 */
async function register(pickup: RenderPickup, report: EndedRender): Promise<TimelineExecutionEvent> {
  const { row, step } = pickup;
  const failed: TimelineExecutionEvent = { type: "failure", fence: row.fence, reason: "save_failed" };
  const video = report.video;
  if (video === null || video.storageKey !== step.request.videoKey) return failed;
  try {
    const outcome = await ingestReportService.applyIngestReport({
      storageKey: video.storageKey,
      outcome: "completed",
      sha256: video.sha256,
      sizeBytes: video.sizeBytes,
      contentType: video.contentType,
      width: video.width,
      height: video.height,
      durationSeconds: video.durationSeconds,
      cover: video.cover === null ? null : { ...video.cover },
    });
    if (outcome.status !== "registered" && outcome.status !== "already_registered") return failed;
    return { type: "success", fence: row.fence, resultAssetId: outcome.assetId };
  } catch (err) {
    if (err instanceof NotFoundError) return failed;
    throw err;
  }
}

/**
 * Settle a terminal report found by a pickup of a running export.
 * @param pickup - The pickup.
 * @param report - The terminal report.
 * @returns Nothing.
 * @throws {Error} When a write fails.
 */
async function finish(pickup: RenderPickup, report: EndedRender): Promise<void> {
  const fence = pickup.row.fence;
  if (Date.now() >= pickup.endsAt || report.state === "expired") return settle(pickup, report, { type: "deadline" });
  if (report.state === "done") return settle(pickup, report, await register(pickup, report));
  const reason = report.state === "failed" ? (report.failureReason ?? "render_failed") : "container_cancelled";
  return settle(pickup, report, { type: "failure", fence, reason });
}

/**
 * Act on a cancel's answer for a cancelling export: a terminal report settles and acknowledges the cancel.
 * @param pickup - The pickup.
 * @returns Nothing.
 * @throws {StillRunning} Until the cancel's answer is terminal.
 * @throws {Error} When a write fails.
 */
async function cancelling(pickup: RenderPickup): Promise<void> {
  const { request } = pickup.step;
  const answer = await cancelRenderJob(request.jobId, { deadlineAt: request.deadlineAt }, pickup.endsAt);
  if (answer.kind === "disabled" || answer.kind === "unconfigured") return settle(pickup, DISABLED, { type: "failure", fence: pickup.row.fence, reason: "feature_disabled" });
  if (answer.kind === "report" && ended(answer.report)) return settle(pickup, answer.report, { type: "cancelAck" });
  throw new StillRunning(Date.now() + getTimelineConfig().web_animation.poll_interval_ms);
}

/**
 * Read the render job, submitting it when the Worker holds none, and settle it once it ends.
 * @param pickup - The pickup.
 * @returns Nothing.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When a write or a call fails.
 */
async function running(pickup: RenderPickup): Promise<void> {
  const { step: { request }, endsAt, row } = pickup;
  let answer: IngestAnswer<WebAnimationRenderJobReport> = await readRenderJob(request.jobId, endsAt);
  if (answer.kind === "missing") {
    if (Date.now() >= request.deadlineAt) {
      if (await owns(pickup)) await move(row, { type: "deadline" });
      return;
    }
    answer = await submitRenderJob(request, endsAt);
    if (answer.kind === "unavailable") logger.warn({ executionId: row.id, jobId: request.jobId }, "web_animation_render_container_start_refused");
  }
  if (answer.kind === "disabled" || answer.kind === "unconfigured") return settle(pickup, DISABLED, { type: "failure", fence: row.fence, reason: "feature_disabled" });
  const report = answer.kind === "report" ? answer.report : null;
  if (report !== null && ended(report)) return finish(pickup, report);
  if (Date.now() >= endsAt) {
    const stopped = await cancelRenderJob(request.jobId, { deadlineAt: request.deadlineAt }, endsAt);
    if (stopped.kind === "report" && ended(stopped.report)) return finish(pickup, stopped.report);
  } else if (report !== null && report.phase !== null && report.phase !== row.phase) {
    await move(row, { type: "progress", fence: row.fence, phase: report.phase });
  }
  throw new StillRunning(Date.now() + getTimelineConfig().web_animation.poll_interval_ms);
}

/**
 * One pickup of an export this pickup already took.
 * @param held - The pickup's hold.
 * @param input - The export's frozen input.
 * @returns Nothing.
 * @throws {StillRunning} While the render job runs.
 * @throws {Error} When a write or a call fails; the job's retry picks it up again.
 */
export async function runExport(held: Held, input: Extract<WebAnimationExecutionInput, { kind: "web_animation_export" }>): Promise<void> {
  const { row } = held;
  let step = storedStep(row.steps, "render_job", webAnimationRenderJobRequestSchema);
  if (step === undefined) {
    step = await newStep(row, input);
    if (!(await timelineExecutionRepo.recordSteps({ id: row.id, fence: row.fence, steps: [step, ...row.steps] }))) return;
  }
  const pickup: RenderPickup = { ...held, step, endsAt: endsAtOf(step.request.deadlineAt) };
  if (row.status === "cancelling") return cancelling(pickup);
  return running(pickup);
}

