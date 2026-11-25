// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The container step runner of the planned video tools (inner#1306; frames-split design §5.4 job identities, §7.15, §7.19):
 * each container step runs its attempts up to the frozen retries under its own job ids, a done output recorded and pinned
 * with the run and a failed attempt's output retired; a chunk list answers its first chunk failed for good at once.
 */
import type { z } from "zod";
import { getMiniToolsConfig } from "@breatic/core";
import { miniToolStepStateSchema, openContainerOutputs, openMiniToolPlanJob, recordMiniToolStepResult, upstreamStepRepo } from "@breatic/domain";
import { DeadlinePassed, miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, type MiniToolPlanJobRequest, type MiniToolPlanRecipe } from "@breatic/shared";
import { advanceMiniToolPlanJob, type EndedMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { advanceStagedMiniToolPlanJob, type StagedMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { StillRunning } from "@worker/handlers/still-running.js";

/** The frozen facts every container step of a run reads. */
export interface ContainerRun {
  taskId: string;
  projectId: string;
  sourceKey: string;
  container: { containerClass: string; limits: MiniToolPlanJobRequest["limits"]; chunkRetries: number };
  /** The log name prefix of this tool's steps. */
  log: string;
}
type Step = upstreamStepRepo.UpstreamStep;
/** A step that ended: its object key, or why it failed; `expired` marks a step whose next attempt was due after the deadline. */
export type StepEnded = { key: string } | { failed: string; expired?: true };

/**
 * The stored request of a container step, if any.
 * @param step - The step.
 * @returns The request.
 * @throws {never} Never.
 */
export function storedRequest(step: Step): MiniToolPlanJobRequest | null {
  const parsed = miniToolPlanJobRequestSchema.safeParse(step.output.miniToolPlanJob);
  return step.kind === "container_job" && parsed.success ? parsed.data : null;
}

/**
 * Append one step after the task's existing steps.
 * @param taskId - The task.
 * @param planned - The new step.
 * @param planned.kind - Its kind.
 * @param planned.endpoint - Its endpoint.
 * @param planned.itemIndex - Its item index.
 * @returns The appended step.
 * @throws {Error} When persistence fails.
 */
async function appendStep(taskId: string, planned: { kind: Step["kind"]; endpoint: string; itemIndex: number | null }): Promise<Step> {
  const existing = await upstreamStepRepo.listSteps(taskId);
  const position = existing.length;
  const rows = await upstreamStepRepo.ensureSteps(taskId, [...existing.map(({ kind, endpoint, itemIndex }) => ({ kind, endpoint, itemIndex })), planned]);
  const appended = rows.find((row) => row.position === position);
  if (appended === undefined) throw new Error("Appended step disappeared");
  return appended;
}

/**
 * The step of a registered job's attempt: the one whose stored request names its job id, else a new one appended after the
 * task's steps while the deadline has not passed (an attempt opened after it is never submitted).
 * @param taskId - The task.
 * @param jobId - The job id.
 * @param endpoint - The class the job runs on.
 * @param deadlineAt - The task deadline.
 * @param open - Whether a new step may be appended.
 * @returns The step and its stored request, if it has one; null when no step holds the job and the deadline has passed;
 * `unopened` when no step holds it and none may be appended.
 * @throws {Error} When persistence fails.
 */
export async function jobStep(taskId: string, jobId: string, endpoint: string, deadlineAt: number, open: boolean): Promise<{ step: Step; request: MiniToolPlanJobRequest | null } | null | "unopened"> {
  const steps = await upstreamStepRepo.listSteps(taskId);
  const found = steps.find((step) => storedRequest(step)?.jobId === jobId);
  if (found !== undefined) return { step: found, request: storedRequest(found) };
  if (!open) return "unopened";
  if (Date.now() >= deadlineAt) return null;
  return { step: await appendStep(taskId, { kind: "container_job", endpoint, itemIndex: steps.length }), request: null };
}

/**
 * A step's persisted state, if any.
 * @param step - The step.
 * @returns The state.
 * @throws {z.ZodError} When the stored state is malformed.
 */
function stateOf(step: Step): z.infer<typeof miniToolStepStateSchema> | null {
  return step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
}

/** One unregistered container step: its attempts' job ids, the output key of each, and its recipe. */
export interface ContainerStep {
  contentType: string;
  jobId: (attempt: number) => string;
  outputKey: (jobId: string) => string;
  build: () => Promise<{ recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }>;
  /** The failed line of a job that failed for good. */
  failed: (reason: string) => StepEnded;
}

/**
 * Advance a container step: run its attempts up to the frozen retries, a done output recorded and pinned with the run and a
 * failed attempt's output retired.
 * @param run - The run.
 * @param planned - The step.
 * @param deadlineAt - The task deadline.
 * @param open - Whether a next attempt may be opened; when not, only an attempt already opened is advanced.
 * @returns The output, the failure (`expired` when a next attempt is due after the deadline, ingest ended an attempt at it,
 * or a job can no longer be submitted or waited for), or null when the next attempt is not opened.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
async function advanceAttempts(run: ContainerRun, planned: ContainerStep, deadlineAt: number, open: boolean): Promise<StepEnded | null> {
  let reason = "tool_failed";
  const { containerClass } = run.container;
  for (let attempt = 1; attempt <= run.container.chunkRetries + 1; attempt += 1) {
    const jobId = planned.jobId(attempt);
    const steps = await upstreamStepRepo.listSteps(run.taskId);
    const existing = steps.find((step) => storedRequest(step)?.jobId === jobId);
    if (existing === undefined && !open) return null;
    // An attempt opened after the deadline is never submitted, so it is never opened: the step ends expired, and the other
    // steps and outputs of the pickup settle as they stand.
    if (existing === undefined && Date.now() >= deadlineAt) return { ...planned.failed("expired"), expired: true };
    const state = existing === undefined ? null : stateOf(existing);
    if (existing !== undefined && state?.result?.outcome === "failed") {
      const failed = readMiniToolPlanJobReport(storedRequest(existing)!, state.result.result);
      if (failed.state === "failed") reason = failed.reason;
      // Ingest ended this attempt at the deadline, so the step expired: no next attempt can be submitted.
      if (reason === "expired") return { ...planned.failed(reason), expired: true };
      continue;
    }
    if (existing !== undefined && state?.result?.outcome === "done") return { key: storedRequest(existing)!.outputs[0]!.storageKey };
    const built = existing === undefined ? await planned.build() : null;
    const candidate: MiniToolPlanJobRequest = existing === undefined
      ? { schemaVersion: 2, jobId, containerClass, deadlineAt, limits: run.container.limits, inputs: built!.inputs,
        outputs: [{ outputIndex: 0, storageKey: planned.outputKey(jobId), contentType: planned.contentType, recipe: built!.recipe }] }
      : storedRequest(existing)!;
    const step = existing ?? await appendStep(run.taskId, { kind: "container_job", endpoint: containerClass, itemIndex: steps.length });
    const { request, consumption } = await openMiniToolPlanJob({ taskId: run.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: "user", request: candidate });
    // The job boundary answers only a terminal report; a running job throws StillRunning, and DeadlinePassed once it can no
    // longer be submitted or waited for: this step expires, while the pickup still reads every other step.
    let ended: EndedMiniToolPlanJob;
    try {
      ended = await advanceMiniToolPlanJob(request);
    } catch (error) {
      if (error instanceof DeadlinePassed) return { ...planned.failed("expired"), expired: true };
      throw error;
    }
    const report = readMiniToolPlanJobReport(request, ended) as EndedMiniToolPlanJob;
    const output = request.outputs[0]!.storageKey;
    await recordMiniToolStepResult({ taskId: run.taskId, stepId: step.id, identity: consumption.identity, outcome: report.state, result: report,
      ...(report.state === "failed" ? { error: { code: report.reason }, presentation: { retire: [output] } } : { presentation: { pin: [output] } }) },
    { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(request, value) });
    if (report.state === "done") return { key: output };
    reason = report.reason;
    if (reason === "expired") return { ...planned.failed(reason), expired: true };
  }
  return planned.failed(reason);
}

/**
 * Advance every chunk step in each pickup (frames-split §5.4 parallel stage); once a chunk has failed for good no chunk
 * opens a new attempt, and the list answers that failure in the same pickup (frames-split §7.19).
 * @param run - The run.
 * @param chunks - The chunk steps in order.
 * @param deadlineAt - The task deadline.
 * @param open - Whether a chunk's next attempt may be opened; when not, a chunk waiting for one answers `unopened`.
 * @returns Every chunk's output in order, the failure of the first chunk in order that failed for good, or `unopened`.
 * @throws {StillRunning} While a chunk runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceChunks(run: ContainerRun, chunks: readonly ContainerStep[], deadlineAt: number, open: boolean): Promise<{ keys: string[] } | Exclude<StepEnded, { key: string }> | { unopened: true }> {
  const ended = new Map<number, StepEnded>();
  const unopened: number[] = [];
  let running = false;
  /**
   * Advance one chunk, noting whether it ended, still runs or waits for its next attempt to be opened.
   * @param k - The chunk.
   * @param open - Whether its next attempt may be opened.
   * @returns Nothing.
   * @throws {Error} When persistence or the job boundary fails.
   */
  const advance = async (k: number, open: boolean): Promise<void> => {
    try {
      const at = await advanceAttempts(run, chunks[k]!, deadlineAt, open);
      if (at === null) unopened.push(k); else ended.set(k, at);
    } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      running = true;
    }
  };
  /**
   * The first chunk in order that failed for good.
   * @returns Its failure, or null.
   * @throws {never} Never.
   */
  const failure = (): Exclude<StepEnded, { key: string }> | null => {
    for (const k of chunks.keys()) {
      const at = ended.get(k);
      if (at !== undefined && !("key" in at)) return at;
    }
    return null;
  };
  // The attempts already opened go first, so a chunk failed for good is known before any chunk opens a new attempt.
  for (const k of chunks.keys()) await advance(k, false);
  if (open) for (const k of unopened.splice(0)) if (failure() === null) await advance(k, true);
  // A chunk failed for good fails the run at once (frames-split §7.19): no running sibling is waited for.
  const failed = failure();
  if (failed !== null) return failed;
  if (unopened.length > 0) return { unopened: true };
  if (running) throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
  return { keys: chunks.map((_chunk, k) => (ended.get(k) as { key: string }).key) };
}

/** A run's one staged output job. */
export interface StagedStep {
  stepKey: string;
  /** The output's upload name prefix. */
  namePrefix: string;
  container: "mp4" | "webm";
  /** The output's index in the run, 0 when absent. */
  outputIndex?: number;
  /** The intermediate keys it consumes (a stitch's chunks), retired with a done result, never before (§7.15, §93 D5-10). */
  retire?: readonly string[];
  build: () => Promise<{ recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }>;
}

/**
 * Advance the job that writes one output of the run, up to the frozen retries, and stage its report (frames-split §7.19):
 * the output is registered only past the run's commit point.
 * @param run - The run.
 * @param planned - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @param open - Whether its next attempt may be opened; when not, a step waiting for one answers `unopened`.
 * @returns Reported once an attempt wrote the output; otherwise the failure: the last attempt's reason once every attempt
 * failed, the refusal of a written output (over_cap, empty), or `expired` when a next attempt is due after the deadline,
 * ingest ended an attempt at it, or the job can no longer be submitted or waited for; or `unopened`.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When persistence or grants fail.
 */
export async function advanceStaged(run: ContainerRun, planned: StagedStep, userId: string, deadlineAt: number, open: boolean): Promise<{ reported: true } | { failed: string; expired?: true } | { unopened: true }> {
  const outputIndex = planned.outputIndex ?? 0;
  let reason = "tool_failed";
  for (let attempt = 1; attempt <= run.container.chunkRetries + 1; attempt += 1) {
    const jobId = `${run.taskId}:${planned.stepKey}:a${attempt}`;
    const steps = await upstreamStepRepo.listSteps(run.taskId);
    let step = steps.find((candidate) => storedRequest(candidate)?.jobId === jobId);
    let request = step === undefined ? null : storedRequest(step);
    if (request === null) {
      if (!open) return { unopened: true };
      // An attempt opened after the deadline is never submitted, so no grant, step or job is opened for it.
      if (Date.now() >= deadlineAt) return { failed: "expired", expired: true };
      const built = await planned.build();
      const [grant] = await openContainerOutputs({ projectId: run.projectId, actingUserId: userId, taskId: run.taskId, deadlineAt,
        outputs: [{ modality: "video", namePrefix: planned.namePrefix, ...(planned.container === "webm" ? { container: "webm" as const } : {}) }] });
      if (grant === undefined) throw new Error(`The ${run.log} output requires its upload grant`);
      request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId, containerClass: run.container.containerClass, deadlineAt, limits: run.container.limits,
        inputs: built.inputs, outputs: [{ ...grant, outputIndex, recipe: built.recipe }] });
      step = await appendStep(run.taskId, { kind: "container_job", endpoint: run.container.containerClass, itemIndex: steps.length });
    }
    let job: StagedMiniToolPlanJob;
    try {
      job = await advanceStagedMiniToolPlanJob({ taskId: run.taskId, stepId: step!.id, chunkIndex: step!.position, chargeTo: "user", request },
        planned.retire === undefined ? {} : { retire: planned.retire });
    } catch (error) {
      // A job that can no longer be submitted or waited for expires this step.
      if (error instanceof DeadlinePassed) return { failed: "expired", expired: true };
      throw error;
    }
    if (job.refused !== null) return { failed: job.refused };
    if (job.report.state === "done" && job.report.outputs.some((output) => output.outputIndex === outputIndex)) return { reported: true };
    reason = job.report.state === "failed" ? job.report.reason : "tool_failed";
    // Ingest ended this attempt at the deadline, so no next attempt can be submitted.
    if (reason === "expired") return { failed: reason, expired: true };
  }
  return { failed: reason };
}
