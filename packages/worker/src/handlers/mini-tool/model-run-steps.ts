// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tool-independent step runner of the model runs (inner#1306 execution design §10.7) and the pure rules of their failures
 * (§10.3–§10.5): a `generate` step submitted once under a stored intent and its link fetched into a derived key, a container
 * step run to the frozen retries, each done object found again by its frozen step key along a retry chain.
 */
import { z } from "zod";
import { getMiniToolsConfig, getWorkerConfig, logger } from "@breatic/core";
import {
  appendMiniToolStepDeliveredCosts, backendUploadService, clearStepSending, endMiniToolModelStep, getStepTicket, markStepSending, MINI_TOOL_MODEL_ROUTE,
  miniToolStepStateSchema, openContainerOutputs, openMiniToolPlanJob, recordMiniToolStepResult, recordStepSendNotAccepted, storeStepTicket, taskRepo,
  upstreamCloneRepo, upstreamStepRepo, type RecordMiniToolStepResultInput,
} from "@breatic/domain";
import {
  DeadlinePassed, miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, type MiniToolPlanExact, type MiniToolPlanJobRequest,
  type MiniToolPlanRecipe, type MiniToolPlanTarget, type VideoPresentationLedger, type VideoPresentationLedgerReceipt,
} from "@breatic/shared";
import type { EraseFailureReason, ExpandFailureReason, LipsyncFailureReason, MiniToolExecutionRegistered } from "@breatic/shared/mini-tools";
import { lipsyncFailureReason, type LipsyncPersonState, type LipsyncPersonStep } from "@worker/handlers/mini-tool/lipsync-steps.js";
import { advanceMiniToolPlanJob, planReadUntil, type EndedMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { appendStep, stepWorkKey } from "@worker/handlers/mini-tool/prepare-model-input.js";
import { advanceRegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { registered } from "@worker/handlers/mini-tool/run-video-tool.js";
import { chunkInputId, FullLedgerInvalid, readJobLedger, SOURCE_INPUT_ID, windowDuration, windowEntries } from "@worker/handlers/video-presentation-recipes.js";
import { costsOf, NoUpstreamAvailable, SendNotAccepted, UpstreamRequestRejected, UpstreamTaskFailed } from "@breatic/provider";
import type { MediaInput } from "@breatic/provider/media";
import { MediaRunFailed, runMedia, type MediaRunDeps, type MediaRunDone } from "@worker/handlers/media-run.js";
import { mediaRunner, sourceOf } from "@worker/handlers/model-task.js";
import { withUnderstandSlot } from "@worker/handlers/understand-slots.js";
import { MiniToolStepFailed } from "@worker/handlers/mini-tool/step-failed.js";
import { StillRunning } from "@worker/handlers/still-running.js";

/** A model's configured asynchronous rejection field: a dot path into the structured error and the value it holds. */
export interface ModelAsyncRejection { path: string; equals: unknown }
/** A paid model step's failure category. */
export type ModelStepCategory = "model_rejected" | "timeout" | "failed";

/**
 * Read a dot path inside a structured error value.
 * @param value - The structured error.
 * @param path - The dot path.
 * @returns The value there, or undefined.
 * @throws {never} Never.
 */
function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * A paid model step's failure category from provider's errors (execution design §11.3 table); never guessed from error
 * text. A refusal at submit (400, 422), an input no upstream takes and the model's configured asynchronous rejection are
 * the model's; a passed deadline, and a run every upstream failed with 408, 429, 5xx or a request that never left, are
 * timeouts; anything else failed.
 * @param error - What the step's run threw.
 * @param rejection - The model's `async_rejection`, when it has one.
 * @returns The category.
 * @throws {never} Never.
 */
export function modelStepCategory(error: unknown, rejection: ModelAsyncRejection | undefined): ModelStepCategory {
  if (error instanceof DeadlinePassed) return "timeout";
  if (!(error instanceof MediaRunFailed)) return "failed";
  const reason = error.reason;
  if (reason instanceof UpstreamRequestRejected) return reason.status === 400 || reason.status === 422 ? "model_rejected" : "failed";
  if (reason instanceof NoUpstreamAvailable) {
    if (reason.reasons.some((r) => r.kind === "unsupported_input")) return "model_rejected";
    const failed = reason.reasons.length > 0 && reason.reasons.every((r) => r.kind === "failed");
    const transient = reason.reasons.some((r) => r.kind === "failed" && (r.failure === "not_sent"
      || (r.status !== undefined && (r.status === 408 || r.status === 429 || r.status >= 500))));
    return failed && transient ? "timeout" : "failed";
  }
  if (reason instanceof UpstreamTaskFailed && rejection !== undefined && atPath(reason.detail, rejection.path) === rejection.equals) return "model_rejected";
  return "failed";
}

/** A tracking analysis's failure as it is stored (execution design §10.3). */
export interface TrackedMaskFailure { code: "empty_foreground" | "tracking_output_mismatch" | "model_rejected" | "timeout" | "failed"; step: "prepare" | "track" | "join" }

/** A tracking analysis that ended at a step, carrying the code and step the analysis stores. */
export class TrackedMaskFailed extends Error {
  /**
   * Name the failure.
   * @param failure - Its code and step.
   */
  constructor(readonly failure: TrackedMaskFailure) { super(`${failure.step}: ${failure.code}`); this.name = "TrackedMaskFailed"; }
}

/**
 * The stored failure of a tracking step (execution design §10.3 code table): a container job's `empty_foreground` or
 * `tracking_output_mismatch` keeps its name and any other job failure is `failed`; the tracker follows `modelStepCategory`
 * with no rejection field.
 * @param step - The step that failed.
 * @param cause - A failed job's reason, or what the step threw.
 * @returns The code and step.
 * @throws {never} Never.
 */
export function trackedMaskFailure(step: TrackedMaskFailure["step"], cause: { reason: string } | unknown): TrackedMaskFailure {
  if (cause !== null && typeof cause === "object" && "reason" in cause && typeof cause.reason === "string") {
    return { code: cause.reason === "empty_foreground" || cause.reason === "tracking_output_mismatch" ? cause.reason : "failed", step };
  }
  return { code: modelStepCategory(cause, undefined), step };
}

/**
 * The category of a failed erase composite (execution design §10.4 failure table): a result of another frame count than the
 * grid keeps its name, anything else is `failed`.
 * @param reason - The job's reason.
 * @returns The category.
 * @throws {never} Never.
 */
export function eraseContainerCategory(reason: string): "model_output_mismatch" | "failed" {
  return reason === "model_output_mismatch" ? "model_output_mismatch" : "failed";
}

/** One expand window's progress. */
export interface ExpandWindowState {
  windowIndex: number;
  state: "unsubmitted" | "submitted" | "done";
  failure: { step: ExpandFailureReason["windows"][number]["step"]; category: Exclude<ExpandFailureReason["windows"][number]["category"], "stopped"> } | null;
}

/**
 * The one failure reason of an expand (execution design §10.5): a line per window that did not succeed, a window that never
 * submitted after a failure or an expiry stopped at `generate`.
 * @param windows - Every window's progress in order.
 * @param shared - The failed step outside every window, or null.
 * @returns The reason.
 * @throws {never} Never.
 */
export function expandFailureReason(windows: readonly ExpandWindowState[], shared: ExpandFailureReason["shared"]): ExpandFailureReason {
  return { kind: "expand", shared, windows: windows.flatMap((window): ExpandFailureReason["windows"] => {
    if (window.failure !== null) return [{ windowIndex: window.windowIndex, step: window.failure.step, category: window.failure.category }];
    return window.state === "done" ? [] : [{ windowIndex: window.windowIndex, step: "generate", category: "stopped" }];
  }) };
}

/**
 * Where a planned model run stands, kept by its runner as it walks, so a throw that ends the run still ends it with the
 * tool's own reason (execution design §9.4, §10.4, §10.5). The expand windows and the lip-sync people are the runner's own
 * progress, read when the run ends.
 */
export type ModelRunPosition =
  | { tool: "video.erase"; step: Exclude<EraseFailureReason["step"], "expired"> }
  | { tool: "video.expand"; windows: ExpandWindowState[];
    current: { window: number; step: ExpandFailureReason["windows"][number]["step"] } | { shared: "composite" | "stitch" } }
  | { tool: "video.lip-sync"; people: (LipsyncPersonState & { succeeded: boolean })[];
    current: { personId: string; step: LipsyncPersonStep } | { shared: "prepare" | "composite" | "stitch" } };
/** The holder a model runner writes its position into, null until its walk starts. */
export interface ModelRunAt { position: ModelRunPosition | null }

/**
 * The reason a planned model run ends with when it throws past its budget or on its last attempt (execution design §9.4,
 * §10.4, §10.5): an expiry is `expired` / `timeout`, the expand window then running keeping its step; any other throw is
 * the step the run stood at with `failed`, the walk's first step when it never started.
 * @param tool - The run's tool.
 * @param position - Where its runner stood, or null.
 * @param expired - Whether the run's budget ended.
 * @returns The reason.
 * @throws {never} Never.
 */
export function modelRunFailure(tool: ModelRunPosition["tool"], position: ModelRunPosition | null, expired: boolean): EraseFailureReason | ExpandFailureReason | LipsyncFailureReason {
  const category = expired ? "timeout" : "failed";
  const expiry = { step: "expired", category: "timeout" } as const;
  if (tool === "video.erase") {
    return { kind: "erase", step: expired ? "expired" : position?.tool === "video.erase" ? position.step : "prepare", category };
  }
  if (tool === "video.expand") {
    const at = position?.tool === "video.expand" ? position : null;
    if (at === null) return expired ? { kind: "expand", windows: [], shared: expiry } : { kind: "expand", windows: [{ windowIndex: 0, step: "window", category }], shared: null };
    const windows = at.windows.map((window) => ({ ...window }));
    const current = at.current;
    if ("window" in current) windows[current.window]!.failure ??= { step: current.step, category };
    return expandFailureReason(windows, expired ? expiry : "shared" in current ? { step: current.shared, category } : null);
  }
  const at = position?.tool === "video.lip-sync" ? position : null;
  const people = (at?.people ?? []).map((person) => ({ ...person }));
  if (expired) return lipsyncFailureReason(people, expiry);
  const current = at?.current ?? { shared: "prepare" as const };
  if ("shared" in current) return lipsyncFailureReason(people, { step: current.shared, category });
  const person = people.find((candidate) => candidate.personId === current.personId)!;
  person.failure ??= { step: current.step, category };
  return lipsyncFailureReason(people, null);
}

/** The frozen facts every model run's steps read. */
export interface ModelStepRun {
  taskId: string;
  projectId: string;
  sourceKey: string;
  container: { containerClass: string; limits: MiniToolPlanJobRequest["limits"]; chunkRetries: number };
  retry?: { runId: string };
  /** The log name prefix of this tool's steps. */
  log: string;
}
type Step = Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number];
/**
 * A step that ended: its object key, or why it failed; `expired` marks a step whose next attempt was due after the run's
 * deadline, which ends a model run with its tool's timeout reason (execution design §9.4, §10.4, §10.5).
 */
export type StepEnded = { key: string } | { failed: string; step?: string; expired?: true };

const objectResult = z.strictObject({ stepKey: z.string().min(1), object: z.string().min(1), providerURL: z.url() });
const retryOf = z.object({ miniToolExecution: z.object({ retry: z.object({ runId: z.uuid() }).optional() }) });

/**
 * An intermediate object's key: the step key, a colon and the attempt's id (§97 D17-6).
 * @param stepKey - The step key.
 * @param attemptId - The attempt's id.
 * @returns The object key.
 * @throws {never} Never.
 */
export function stepObjectKey(stepKey: string, attemptId: string): string {
  return `${stepKey}:${attemptId}`;
}

/**
 * The runs whose steps this run may use: itself, then each earlier run its retry chain names (§97 D21-6).
 * @param run - The run.
 * @returns The task ids, this run first.
 * @throws {Error} When a run of the chain cannot be read.
 */
export async function runsOf(run: ModelStepRun): Promise<string[]> {
  const runs = [run.taskId];
  let next = run.retry?.runId;
  while (next !== undefined && !runs.includes(next)) {
    runs.push(next);
    const task = await taskRepo.getMiniToolExecutionTask(next);
    next = task === null ? undefined : retryOf.safeParse(task.params).data?.miniToolExecution.retry?.runId;
  }
  return runs;
}

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
 * The step of a registered job's attempt: the one whose stored request names its job id, else a new one appended after the
 * task's steps while the deadline has not passed (an attempt opened after it is never submitted).
 * @param taskId - The task.
 * @param jobId - The job id.
 * @param endpoint - The class the job runs on.
 * @param deadlineAt - The task deadline.
 * @returns The step and its stored request, if it has one; null when no step holds the job and the deadline has passed.
 * @throws {Error} When persistence fails.
 */
export async function jobStep(taskId: string, jobId: string, endpoint: string, deadlineAt: number): Promise<{ step: Step; request: MiniToolPlanJobRequest | null } | null> {
  const steps = await upstreamStepRepo.listSteps(taskId);
  const found = steps.find((step) => storedRequest(step)?.jobId === jobId);
  if (found !== undefined) return { step: found, request: storedRequest(found) };
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

/**
 * The object of a done step of an earlier run of the chain, found by its frozen step key.
 * @param run - The run.
 * @param stepKey - The step key.
 * @returns The key, or null.
 * @throws {Error} When the step read fails.
 */
async function reused(run: ModelStepRun, stepKey: string): Promise<string | null> {
  for (const owner of (await runsOf(run)).slice(1)) {
    for (const step of await upstreamStepRepo.listSteps(owner)) {
      const state = stateOf(step);
      if (state?.result?.outcome !== "done") continue;
      const request = storedRequest(step);
      if (request !== null && request.jobId.includes(`:${stepKey}:`)) return request.outputs[0]!.storageKey;
      const object = objectResult.safeParse(state.result.result);
      if (step.kind === "generate" && object.success && object.data.stepKey === stepKey) return object.data.object;
    }
  }
  return null;
}

/** One model step: the catalog model it runs, its identity in the run and its call in our param names. */
export interface GenerateStep {
  /** The catalog model; the step row's endpoint. */
  model: string;
  itemIndex: number;
  stepKey: string;
  contentType: string;
  /** The call in our param names and the prompt, read when the step's ticket is first planned. */
  input: () => Promise<MediaInput>;
  /** The model's configured asynchronous rejection, for `modelStepCategory`. */
  rejection?: ModelAsyncRejection;
  /** The failure category of what the step's run threw, `modelStepCategory` with `rejection` when absent. */
  category?: (error: unknown) => string;
}

/**
 * The dependencies `runMedia` reads a model step's run with: the step row holds its ticket and send mark.
 * @param taskId - The run's task.
 * @param deadlineAt - The run's deadline.
 * @returns The dependencies.
 */
function stepRunDeps(taskId: string, deadlineAt: number): MediaRunDeps {
  return {
    // Built on first use: this process's one runner holds each upstream's concurrency.
    get runner() { return mediaRunner(); },
    tickets: {
      getProviderTicket: (stepId: string) => getStepTicket(taskId, stepId),
      storeTicket: (stepId: string, ticket: { version: number } & Record<string, unknown>) => storeStepTicket(taskId, stepId, ticket),
      markSending: (stepId: string) => markStepSending(taskId, stepId, deadlineAt),
      clearSending: (stepId: string) => clearStepSending(taskId, stepId),
    },
    clones: upstreamCloneRepo,
    sourceOf,
    // A model step is never a task from before provider.
    legacy: () => Promise.resolve({}),
    readingPlace: withUnderstandSlot,
    pollIntervalMs: getWorkerConfig().poll_interval,
  };
}

const stepResult = { kind: "generate" as const, parse: (value: unknown) => objectResult.parse(value) };

/**
 * Fetch a returned step's link into its derived key and record it done with the pin; a fetch that fails records the
 * step failed and nothing is sent again (execution design §11.2 output row).
 * @param run - The run.
 * @param planned - The step.
 * @param stepId - Its row.
 * @param link - The upstream's link.
 * @param userId - The run's user.
 * @param deadlineAt - The run's deadline.
 * @returns The object, or `failed`.
 * @throws {Error} When recording fails.
 */
async function fetchReturned(run: ModelStepRun, planned: GenerateStep, stepId: string, link: string, userId: string, deadlineAt: number): Promise<StepEnded> {
  const key = stepObjectKey(planned.stepKey, stepId);
  const identity = { kind: "provider" as const, stepId };
  try {
    await backendUploadService.transferUrlToDerived(link, { storageKey: key, contentType: planned.contentType, projectId: run.projectId, actingUserId: userId, deadlineAt });
  } catch (error) {
    logger.error({ err: error, ctx: { taskId: run.taskId, stepId, stepKey: planned.stepKey } }, `mini_tool_${run.log}_output_fetch_failed`);
    await recordMiniToolStepResult({ taskId: run.taskId, stepId, identity, outcome: "failed", result: { stepKey: planned.stepKey, object: key, providerURL: link },
      error: { code: "failed", message: error instanceof Error ? error.message : String(error) } }, stepResult);
    return { failed: "failed" };
  }
  await recordMiniToolStepResult({ taskId: run.taskId, stepId, identity, outcome: "done", result: { stepKey: planned.stepKey, object: key, providerURL: link },
    presentation: { pin: [key] } }, stepResult);
  return { key };
}

/** A model step's call: the catalog model, its input in our names and how its failures are classified. */
export interface ModelStepCall {
  model: string;
  input: () => Promise<MediaInput>;
  category: (error: unknown) => string;
}

/**
 * Run a model step's provider ticket against its row until the upstream answered (execution design §11.2): a step
 * found returned gives its link again; a done run ends the step returned with its link and costs; a failed run ends it
 * failed with its category and costs; a send the upstream did not take comes back after `job_backoff_delay_ms × 2^n`
 * and ends the step `timeout` after `job_attempts`; any other throw keeps the costs it handed over on the step and is
 * thrown again, the ticket and send mark kept for the next pickup.
 * @param taskId - The run's task.
 * @param step - The step's row.
 * @param call - The step's call.
 * @param deadlineAt - The run's deadline.
 * @param log - The log name prefix of the tool's steps.
 * @returns The upstream's link, or the failure category.
 * @throws {StillRunning} While the run is running upstream or a refused send waits.
 * @throws {Error} When the run threw before ending (the queue retries it) or persistence fails.
 */
export async function runModelStep(taskId: string, step: Step, call: ModelStepCall, deadlineAt: number, log: string): Promise<{ link: string } | { failed: string }> {
  const returned = step.output.providerReturn as { link: string } | undefined;
  if (returned !== undefined) return { link: returned.link };
  const ctx = { taskId, stepId: step.id, model: call.model };
  let done: MediaRunDone;
  try {
    done = await runMedia({
      taskId: step.id, studioId: null, model: call.model, displayName: call.model,
      input: () => call.input(), route: MINI_TOOL_MODEL_ROUTE, deadlineAt, outputCount: 1, lastAttempt: false,
    }, stepRunDeps(taskId, deadlineAt));
  } catch (error) {
    if (error instanceof StillRunning) throw error;
    if (error instanceof MediaRunFailed) {
      const category = call.category(error);
      logger.error({ err: error, ctx: { ...ctx, category } }, `mini_tool_${log}_provider_failed`);
      await endMiniToolModelStep({ taskId, stepId: step.id, end: { kind: "failed", category: category as "failed", error: { code: category, message: error.message } }, costs: error.costs, servedBy: null });
      return { failed: category };
    }
    if (error instanceof SendNotAccepted) {
      const refused = await recordStepSendNotAccepted(taskId, step.id);
      const { job_attempts: attempts, job_backoff_delay_ms: delay } = getWorkerConfig();
      if (refused < attempts) throw new StillRunning(Date.now() + delay * 2 ** refused);
      logger.error({ err: error, ctx: { ...ctx, refused } }, `mini_tool_${log}_send_not_accepted`);
      await endMiniToolModelStep({ taskId, stepId: step.id, end: { kind: "failed", category: "timeout", error: { code: "timeout", message: error.message } }, costs: [], servedBy: null });
      return { failed: "timeout" };
    }
    // The run did not end: what it billed stays on the step, which keeps its ticket for the next pickup to recover.
    await appendMiniToolStepDeliveredCosts(taskId, step.id, costsOf(error));
    throw error;
  }
  const link = done.outputs.find((output) => output.kind === "url");
  const costs = [...done.costs, ...done.passedOverCosts];
  if (link === undefined || link.kind !== "url") {
    logger.error({ ctx }, `mini_tool_${log}_provider_output_unreadable`);
    await endMiniToolModelStep({ taskId, stepId: step.id, end: { kind: "failed", category: "failed", error: { code: "failed", message: "The provider answered no readable link" } }, costs, servedBy: done.servedBy });
    return { failed: "failed" };
  }
  await endMiniToolModelStep({ taskId, stepId: step.id, end: { kind: "returned", link: link.url }, costs, servedBy: done.servedBy });
  return { link: link.url };
}

/**
 * Advance a model step (execution design §11.2): reuse a done object, or run its ticket with `runModelStep` and fetch the
 * returned link into the step's derived key.
 * @param run - The run.
 * @param planned - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The object, or the failure category (`timeout`, marked expired, when the step is due after the deadline).
 * @throws {StillRunning} While the run is running upstream or a refused send waits.
 * @throws {Error} When the run threw before ending (the queue retries it) or persistence fails.
 */
export async function advanceGenerate(run: ModelStepRun, planned: GenerateStep, userId: string, deadlineAt: number): Promise<StepEnded> {
  const steps = await upstreamStepRepo.listSteps(run.taskId);
  let step = steps.find((candidate) => candidate.kind === "generate" && candidate.endpoint === planned.model && candidate.itemIndex === planned.itemIndex);
  if (step === undefined) {
    const original = await reused(run, planned.stepKey);
    if (original !== null) return { key: original };
    // A call opened after the deadline is never sent, so no step is appended for it: the step ends expired, a timeout.
    if (Date.now() >= deadlineAt) return { failed: "timeout", expired: true };
    step = await appendStep(run.taskId, { kind: "generate", endpoint: planned.model, itemIndex: planned.itemIndex });
  }
  const state = stateOf(step);
  if (state?.result?.outcome === "done") return { key: objectResult.parse(state.result.result).object };
  if (step.status === "failed") {
    const ended = step.output.modelStepError as { category?: string } | undefined;
    return { failed: ended?.category ?? (typeof state?.error?.code === "string" ? state.error.code : "failed") };
  }
  const answered = await runModelStep(run.taskId, step, {
    model: planned.model, input: planned.input,
    category: (error) => planned.category?.(error) ?? modelStepCategory(error, planned.rejection),
  }, deadlineAt, run.log);
  if ("failed" in answered) return answered;
  return fetchReturned(run, planned, step.id, answered.link, userId, deadlineAt);
}

/** One container step's request, whatever names it. */
interface ContainerStepRequest {
  contentType: string;
  build: () => Promise<{ recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }>;
  /** The failed line of a job that failed for good. */
  failed: (reason: string) => StepEnded;
  /** The class the job runs on, the run's when absent. */
  containerClass?: string;
  /** The limits the job runs under, the run's when absent. */
  limits?: MiniToolPlanJobRequest["limits"];
  /** The output's storage key for an attempt's job id, `stepWorkKey(sourceKey, jobId, contentType)` when absent. */
  outputKey?: (jobId: string) => string;
  /** The step's item index and the consumption's chunk index, the step's position when absent. */
  chunkIndex?: number;
  /** The pins a done output is recorded with, pinned with the run when absent. */
  done?: (output: string) => NonNullable<RecordMiniToolStepResultInput["presentation"]>;
}

/**
 * One container step: a step key, whose attempt's job id is `${taskId}:${stepKey}:a${attempt}` unless `jobId` names it and
 * whose done output an earlier run of the chain may hand over; or only `jobId`, a step no other run reuses.
 */
export type ContainerStep = ContainerStepRequest & ({ stepKey: string; jobId?: (attempt: number) => string } | { stepKey?: undefined; jobId: (attempt: number) => string });

/**
 * Advance a container step: reuse its done output, or run its attempts up to the frozen retries, a done output recorded with
 * its pins and a failed attempt's output retired.
 * @param run - The run.
 * @param planned - The step.
 * @param deadlineAt - The task deadline.
 * @param open - Whether a next attempt may be opened; when not, only an attempt already opened is advanced.
 * @returns The output, the failure (`expired` when a next attempt is due after the deadline, ingest ended an attempt at it,
 * or a job can no longer be submitted or waited for), or null when the next attempt is not opened.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
async function advanceAttempts(run: ModelStepRun, planned: ContainerStep, deadlineAt: number, open: boolean): Promise<StepEnded | null> {
  let reason = "tool_failed";
  const containerClass = planned.containerClass ?? run.container.containerClass;
  for (let attempt = 1; attempt <= run.container.chunkRetries + 1; attempt += 1) {
    const jobId = planned.stepKey === undefined ? planned.jobId(attempt) : planned.jobId?.(attempt) ?? `${run.taskId}:${planned.stepKey}:a${attempt}`;
    const steps = await upstreamStepRepo.listSteps(run.taskId);
    const existing = steps.find((step) => storedRequest(step)?.jobId === jobId);
    if (existing === undefined && attempt === 1 && planned.stepKey !== undefined) {
      const original = await reused(run, planned.stepKey);
      if (original !== null) return { key: original };
    }
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
      ? { schemaVersion: 2, jobId, containerClass, deadlineAt, limits: planned.limits ?? run.container.limits, inputs: built!.inputs,
        outputs: [{ outputIndex: 0, storageKey: planned.outputKey?.(jobId) ?? stepWorkKey(run.sourceKey, jobId, planned.contentType), contentType: planned.contentType, recipe: built!.recipe }] }
      : storedRequest(existing)!;
    const step = existing ?? await appendStep(run.taskId, { kind: "container_job", endpoint: containerClass, itemIndex: planned.chunkIndex ?? steps.length });
    const { request, consumption } = await openMiniToolPlanJob({ taskId: run.taskId, stepId: step.id, chunkIndex: planned.chunkIndex ?? step.position, chargeTo: "user", request: candidate });
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
      ...(report.state === "failed" ? { error: { code: report.reason }, presentation: { retire: [output] } } : { presentation: planned.done?.(output) ?? { pin: [output] } }) },
    { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(request, value) });
    if (report.state === "done") return { key: output };
    reason = report.reason;
    if (reason === "expired") return { ...planned.failed(reason), expired: true };
  }
  return planned.failed(reason);
}

/**
 * Advance a container step: reuse its done output, or run its attempts up to the frozen retries, the output pinned with the
 * run (or recorded with the step's own pins) and a failed attempt's output retired.
 * @param run - The run.
 * @param planned - The step.
 * @param deadlineAt - The task deadline.
 * @returns The output, or the failure.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceContainer(run: ModelStepRun, planned: ContainerStep, deadlineAt: number): Promise<StepEnded> {
  return (await advanceAttempts(run, planned, deadlineAt, true))!;
}

/**
 * A window span start written in float seconds, aligned to the grid time of the frame the window opens on (§10.5; §7.17
 * rounding clock row): a start below that frame's exact start by less than float precision (1e-9 s) is that start.
 * @param start - The span start, exact from its decimal.
 * @param opening - The opening frame's exact start.
 * @returns The span start.
 * @throws {never} Never.
 */
export function alignedSpanStart(start: MiniToolPlanExact, opening: MiniToolPlanExact): MiniToolPlanExact {
  const [sn, sd] = [BigInt(start.numerator), BigInt(start.denominator)];
  const [on, od] = [BigInt(opening.numerator), BigInt(opening.denominator)];
  // opening − start = (on · sd − sn · od) / (od · sd); aligned when 0 < that < 1e-9.
  const gap = on * sd - sn * od;
  return gap > 0n && gap * 1_000_000_000n < od * sd ? opening : start;
}

/**
 * The reduced exact time of seconds written in decimal.
 * @param seconds - The seconds.
 * @returns The exact time.
 * @throws {RangeError} When the number is negative, not finite or only writable in exponent form.
 */
export function exactSeconds(seconds: number): MiniToolPlanExact {
  const text = String(seconds);
  if (!Number.isFinite(seconds) || seconds < 0 || text.includes("e")) throw new RangeError(`${text} seconds have no exact decimal form`);
  const [whole, fraction = ""] = text.split(".");
  const numerator = BigInt(whole! + fraction);
  const denominator = 10n ** BigInt(fraction.length);
  let [a, b] = [numerator, denominator];
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a === 0n ? denominator : a;
  return { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
}

/**
 * Read a run's frozen full ledger; one that fails its receipt fails the run (§91 D3b-9). Reading it starts no new work, so it
 * is read after the deadline too, and a pickup then still reads the jobs submitted before it (`planReadUntil`).
 * @param run - The run.
 * @param receipt - The frozen receipt.
 * @param deadlineAt - The task deadline.
 * @returns The ledger.
 * @throws {MiniToolStepFailed} With `source_ledger_invalid` when the ledger fails its receipt.
 * @throws {Error} When the read fails in transport.
 */
export async function runLedger(run: ModelStepRun, receipt: VideoPresentationLedgerReceipt, deadlineAt: number): Promise<VideoPresentationLedger> {
  try {
    return await readJobLedger(receipt, planReadUntil(deadlineAt));
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    logger.error({ err: error, ctx: { taskId: run.taskId } }, `mini_tool_${run.log}_ledger_invalid`);
    throw new MiniToolStepFailed("source_ledger_invalid");
  }
}

/**
 * Advance every chunk step in each pickup (frames-split §5.4 parallel stage): the list settles only once no chunk still runs,
 * so each running chunk's object is recorded and pinned with the run; once a chunk has failed for good no chunk opens a new
 * attempt, only the attempts already opened are advanced.
 * @param run - The run.
 * @param chunks - The chunk steps in order.
 * @param deadlineAt - The task deadline.
 * @returns Every chunk's output in order, or the failure of the first chunk in order that failed for good.
 * @throws {StillRunning} While a chunk runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceChunks(run: ModelStepRun, chunks: readonly ContainerStep[], deadlineAt: number): Promise<{ keys: string[] } | Exclude<StepEnded, { key: string }>> {
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
  for (const k of unopened) if (failure() === null) await advance(k, true);
  if (running) throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
  return failure() ?? { keys: chunks.map((_chunk, k) => (ended.get(k) as { key: string }).key) };
}

/** A run's one registered output job. */
export interface RegisteredStep {
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
 * Advance the job that writes one registered output of the run, up to the frozen retries.
 * @param run - The run.
 * @param planned - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The registered output, the last attempt's reason once every attempt failed, or `expired` when a next attempt is
 * due after the deadline, ingest ended an attempt at it, or the job can no longer be submitted or waited for.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When persistence, grants or registration fail.
 */
export async function advanceRegistered(run: ModelStepRun, planned: RegisteredStep, userId: string, deadlineAt: number): Promise<MiniToolExecutionRegistered | { failed: string; expired?: true }> {
  const outputIndex = planned.outputIndex ?? 0;
  let reason = "tool_failed";
  for (let attempt = 1; attempt <= run.container.chunkRetries + 1; attempt += 1) {
    const jobId = `${run.taskId}:${planned.stepKey}:a${attempt}`;
    const steps = await upstreamStepRepo.listSteps(run.taskId);
    let step = steps.find((candidate) => storedRequest(candidate)?.jobId === jobId);
    let request = step === undefined ? null : storedRequest(step);
    if (request === null) {
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
    let job: Awaited<ReturnType<typeof advanceRegisteredMiniToolPlanJob>>;
    try {
      job = await advanceRegisteredMiniToolPlanJob({ taskId: run.taskId, stepId: step!.id, chunkIndex: step!.position, chargeTo: "user", request },
        planned.retire === undefined ? {} : { retire: planned.retire });
    } catch (error) {
      // A job that can no longer be submitted or waited for expires this step; the pickup still reads every other step.
      if (error instanceof DeadlinePassed) return { failed: "expired", expired: true };
      throw error;
    }
    const written = job.assets.find((entry) => entry.outputIndex === outputIndex);
    if (job.report.state === "done" && written !== undefined) return await registered(written.asset) as MiniToolExecutionRegistered;
    reason = job.report.state === "failed" ? job.report.reason : "tool_failed";
    // Ingest ended this attempt at the deadline, so no next attempt can be submitted.
    if (reason === "expired") return { failed: reason, expired: true };
  }
  return { failed: reason };
}

/**
 * Run each step in turn, so every step is submitted before the pickup waits on any; the first wait is thrown after all.
 * @param steps - The steps.
 * @returns Their values.
 * @throws {StillRunning} When any step still runs.
 * @throws {Error} When a step fails otherwise.
 */
export async function eachSubmitted<T>(steps: readonly (() => Promise<T>)[]): Promise<T[]> {
  const values: T[] = [];
  let waiting: StillRunning | null = null;
  for (const step of steps) {
    try { values.push(await step()); } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      waiting ??= error;
    }
  }
  if (waiting !== null) throw waiting;
  return values;
}

/** A tracking clip to prepare: the windows of its jobs (`clipJobWindows`), its order and the step key of its prepared video. */
export interface ClipStep {
  stepKey: string;
  /** One window for a clip prepared whole; a reversed clip's chunks in source order. */
  windows: readonly { start: number; end: number }[];
  order: "forward" | "reverse";
  ledger: VideoPresentationLedger;
  target: MiniToolPlanTarget;
  /** The failed line of a job that failed for good. */
  failed: (reason: string) => StepEnded;
}

/**
 * Prepare a tracking clip (execution design §10.2) in the jobs its windows name: one `prepare_model_input` job, or, for a
 * reversed clip chunked by the reverse buffer, one reversed job per chunk and a stitch that joins them latest chunk first,
 * so the k-th chunk of the reversed clip is the (n − 1 − k)-th of the forward one.
 * @param run - The run.
 * @param planned - The clip.
 * @param deadlineAt - The task deadline.
 * @returns The prepared video, or the failure.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceClip(run: ModelStepRun, planned: ClipStep, deadlineAt: number): Promise<StepEnded> {
  const { ledger, target, windows, order } = planned;
  /**
   * The job preparing one window of the clip.
   * @param window - The window.
   * @param window.start - Its first frame.
   * @param window.end - The frame after its last.
   * @param stepKey - Its step key.
   * @returns The step.
   * @throws {never} Never.
   */
  const prepare = (window: { start: number; end: number }, stepKey: string): ContainerStep => ({ stepKey, contentType: "video/mp4", failed: planned.failed,
    build: () => Promise.resolve({ recipe: { kind: "prepare_model_input", inputId: SOURCE_INPUT_ID, window, timescale: ledger.plan.presentation.timescale,
      entries: windowEntries(ledger, window), target, audio: null, order }, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: run.sourceKey }] }) });
  if (windows.length === 1) return advanceContainer(run, prepare(windows[0]!, planned.stepKey), deadlineAt);
  // A chunk's key is the clip's with its index, so no chunk is found again as the whole clip.
  const chunks = await advanceChunks(run, windows.map((window, k) => prepare(window, `${planned.stepKey}.c${k}`)), deadlineAt);
  if (!("keys" in chunks)) return chunks;
  const latestFirst = windows.map((window, k) => ({ window, key: chunks.keys[k]! })).reverse();
  return advanceContainer(run, { stepKey: planned.stepKey, contentType: "video/mp4", failed: planned.failed,
    build: () => Promise.resolve({ recipe: { kind: "stitch", inputId: SOURCE_INPUT_ID, target, audio: null,
      chunks: latestFirst.map((chunk, at) => ({ inputId: chunkInputId(at), duration: windowDuration(ledger, chunk.window) })) },
    inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: run.sourceKey }, ...latestFirst.map((chunk, at) => ({ inputId: chunkInputId(at), storageKey: chunk.key }))] }) }, deadlineAt);
}
