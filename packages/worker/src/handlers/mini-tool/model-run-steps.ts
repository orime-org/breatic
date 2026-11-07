// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The tool-independent step runner of the model runs (inner#1306 execution design §10.7) and the pure rules of their failures
 * (§10.3–§10.5): a `generate` step submitted once under a stored intent and its link fetched into a derived key, a container
 * step run to the frozen retries, each done object found again by its frozen step key along a retry chain.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getMiniToolsConfig, getRawEnvVar, logger } from "@breatic/core";
import {
  backendUploadService, beginMiniToolStepAttempt, failMiniToolStep, getFullModelConfig, miniToolStepStateSchema, openContainerOutputs, openMiniToolPlanJob, recordMiniToolStepIdentity,
  recordMiniToolStepResult, taskRepo, upstreamStepRepo, type FullModelEntry, type MiniToolStepJson,
} from "@breatic/domain";
import {
  DeadlinePassed, HttpRetryError, miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, videoPresentationWorkKeyFor, type MiniToolPlanExact, type MiniToolPlanJobRequest,
  type MiniToolPlanRecipe, type MiniToolPlanTarget, type VideoPresentationLedger, type VideoPresentationLedgerReceipt,
} from "@breatic/shared";
import type { ExpandFailureReason, MiniToolExecutionRegistered } from "@breatic/shared/mini-tools";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { appendStep } from "@worker/handlers/mini-tool/prepare-model-input.js";
import { advanceRegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { registered } from "@worker/handlers/mini-tool/run-video-tool.js";
import { chunkInputId, FullLedgerInvalid, readJobLedger, windowDuration, windowEntries } from "@worker/handlers/video-presentation-recipes.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { runPrediction } from "@worker/providers/wavespeed.js";

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
 * A paid model step's failure category (execution design §9.4, §10.4, §10.5 category tables); never guessed from error text.
 * A refusal at submit (400, 422) and the configured asynchronous rejection are the model's; a passed deadline, exhausted
 * network retries, 408, 429 and 5xx are timeouts; anything else failed.
 * @param error - What the step threw.
 * @param rejection - The model's `async_rejection`, when it has one.
 * @returns The category.
 * @throws {never} Never.
 */
export function modelStepCategory(error: unknown, rejection: ModelAsyncRejection | undefined): ModelStepCategory {
  if (error instanceof DeadlinePassed || error instanceof HttpRetryError) return "timeout";
  if (error instanceof HttpStatusError) {
    if (error.status === 408 || error.status === 429 || error.status >= 500) return "timeout";
    return error.status === 400 || error.status === 422 ? "model_rejected" : "failed";
  }
  if (error instanceof UpstreamTaskFailed && rejection !== undefined && atPath(error.structuredError, rejection.path) === rejection.equals) return "model_rejected";
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
/** A step that ended: its object key, or why it failed. */
export type StepEnded = { key: string } | { failed: string; step?: string };

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

/**
 * A catalog model's WaveSpeed model id.
 * @param name - The catalog model.
 * @returns Its provider model id.
 * @throws {Error} When the catalog offers it through no WaveSpeed upstream.
 */
export function providerModel(name: string): string {
  const id = catalogModel(name).providers?.find((provider) => provider.name === "wavespeed")?.model_id;
  if (typeof id !== "string") throw new Error(`The model ${name} has no WaveSpeed upstream`);
  return id;
}

/**
 * A catalog model's full entry.
 * @param name - The catalog model.
 * @returns The entry.
 * @throws {Error} When the catalog has no such model.
 */
export function catalogModel(name: string): FullModelEntry {
  const model = getFullModelConfig("video").models.find((candidate) => candidate.name === name);
  if (model === undefined) throw new Error(`The catalog has no model ${name}`);
  return model;
}

/** One generate step's identity and request. */
export interface GenerateStep {
  endpoint: string;
  itemIndex: number;
  stepKey: string;
  contentType: string;
  body: () => Promise<Record<string, MiniToolStepJson>>;
  link: (outputs: unknown) => string | null;
  /** The failure category of what the provider call threw. */
  category: (error: unknown) => string;
}

/**
 * Advance a `generate` step: reuse its done object, submit it once under a stored intent, or ask for its stored prediction;
 * once the provider returned, fetch its link into the derived key and record it with the pin in one transaction.
 * @param run - The run.
 * @param planned - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The object, or the failure category.
 * @throws {StillRunning} While the prediction runs.
 * @throws {Error} When persistence or the link fetch fails.
 */
export async function advanceGenerate(run: ModelStepRun, planned: GenerateStep, userId: string, deadlineAt: number): Promise<StepEnded> {
  const steps = await upstreamStepRepo.listSteps(run.taskId);
  let step = steps.find((candidate) => candidate.kind === "generate" && candidate.endpoint === planned.endpoint && candidate.itemIndex === planned.itemIndex);
  if (step === undefined) {
    const original = await reused(run, planned.stepKey);
    if (original !== null) return { key: original };
    step = await appendStep(run.taskId, { kind: "generate", endpoint: planned.endpoint, itemIndex: planned.itemIndex });
  }
  let state = stateOf(step);
  if (state?.result?.outcome === "done") return { key: objectResult.parse(state.result.result).object };
  if (step.status === "failed") return { failed: typeof state?.error?.code === "string" ? state.error.code : "failed" };
  const connection = getFullModelConfig("video").providers.wavespeed;
  const apiKey = getRawEnvVar(connection?.api_key_env ?? "");
  if (!connection?.base_url || !apiKey) throw new Error("The WaveSpeed connection is unavailable");
  let attemptId = state?.attempts.find((attempt) => attempt.resolution.kind === "identity" && attempt.resolution.predictionId === step!.predictionId)?.attemptId ?? null;
  let submitted = false;
  if (step.predictionId === null) {
    const prepared = await beginMiniToolStepAttempt({ taskId: run.taskId, stepId: step.id, attemptId: randomUUID(),
      requestBody: state?.requestBody ?? await planned.body(), deadlineAt: state?.deadlineAt ?? deadlineAt, chargeTo: "user" });
    if (!prepared.shouldSubmit || prepared.attempt === null) throw new Error(`The ${run.log} submit intent requires reconciliation`);
    attemptId = prepared.attempt.attemptId;
    step = prepared.step;
    state = stateOf(step);
  }
  if (attemptId === null || state === null || state.requestBody === null) throw new Error(`The ${run.log} step has no stored submit intent`);
  const owned = step;
  const attempt = attemptId;
  let prediction: Awaited<ReturnType<typeof runPrediction>>;
  try {
    prediction = await runPrediction({ baseUrl: connection.base_url, apiKey }, planned.endpoint, state.requestBody, {
      storedTaskId: owned.predictionId, externalTaskId: owned.id, retryStarting: false, deadlineAt: state.deadlineAt ?? deadlineAt,
      persistTaskId: async (predictionId): Promise<void> => {
        const receipt = await recordMiniToolStepIdentity({ taskId: run.taskId, stepId: owned.id, attemptId: attempt, predictionId });
        if (receipt.conflict) throw new Error("Provider receipt conflicts with its original prediction");
        submitted = true;
      },
    });
  } catch (error) {
    if (error instanceof StillRunning) throw error;
    const category = planned.category(error);
    logger.error({ err: error, ctx: { taskId: run.taskId, stepId: owned.id, stepKey: planned.stepKey, category } }, `mini_tool_${run.log}_provider_failed`);
    // A refusal answered before any prediction existed proves this attempt was never accepted.
    const refused = error instanceof HttpStatusError && owned.predictionId === null && !submitted;
    await failMiniToolStep({ taskId: run.taskId, stepId: owned.id, error: { code: category, message: error instanceof Error ? error.message : String(error) },
      ...(refused ? { attempt: { attemptId: attempt, proof: "rejected" as const } } : {}) });
    return { failed: category };
  }
  const link = planned.link(prediction.outputs);
  if (link === null) {
    logger.error({ ctx: { taskId: run.taskId, stepId: owned.id, stepKey: planned.stepKey } }, `mini_tool_${run.log}_provider_output_unreadable`);
    await failMiniToolStep({ taskId: run.taskId, stepId: owned.id, error: { code: "failed", message: "The provider answered no readable link" } });
    return { failed: "failed" };
  }
  const key = stepObjectKey(planned.stepKey, attempt);
  await backendUploadService.transferUrlToDerived(link, { storageKey: key, contentType: planned.contentType, projectId: run.projectId, actingUserId: userId,
    deadlineAt: state.deadlineAt ?? deadlineAt });
  await recordMiniToolStepResult({ taskId: run.taskId, stepId: owned.id, identity: { kind: "provider", provider: "wavespeed", predictionId: prediction.taskId },
    outcome: "done", result: { stepKey: planned.stepKey, object: key, providerURL: link }, presentation: { pin: [key] } },
  { kind: "generate", parse: (value) => objectResult.parse(value) });
  return { key };
}

/** One container step's identity and request. */
export interface ContainerStep {
  stepKey: string;
  contentType: string;
  build: () => Promise<{ recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }>;
  /** The failed line of a job that failed for good. */
  failed: (reason: string) => StepEnded;
  /** The job id of an attempt, `${taskId}:${stepKey}:a${attempt}` when absent. */
  jobId?: (attempt: number) => string;
  /** The class the job runs on, the run's when absent. */
  containerClass?: string;
}

/**
 * Advance a container step: reuse its done output, or run its attempts up to the frozen retries, the output pinned with the
 * run and a failed attempt's output retired.
 * @param run - The run.
 * @param planned - The step.
 * @param deadlineAt - The task deadline.
 * @returns The output, or the failure.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceContainer(run: ModelStepRun, planned: ContainerStep, deadlineAt: number): Promise<StepEnded> {
  let reason = "tool_failed";
  const containerClass = planned.containerClass ?? run.container.containerClass;
  for (let attempt = 1; attempt <= run.container.chunkRetries + 1; attempt += 1) {
    const jobId = planned.jobId?.(attempt) ?? `${run.taskId}:${planned.stepKey}:a${attempt}`;
    const steps = await upstreamStepRepo.listSteps(run.taskId);
    const existing = steps.find((step) => storedRequest(step)?.jobId === jobId);
    if (existing === undefined && attempt === 1) {
      const original = await reused(run, planned.stepKey);
      if (original !== null) return { key: original };
    }
    const state = existing === undefined ? null : stateOf(existing);
    if (existing !== undefined && state?.result?.outcome === "failed") {
      const failed = readMiniToolPlanJobReport(storedRequest(existing)!, state.result.result);
      if (failed.state === "failed") reason = failed.reason;
      continue;
    }
    if (existing !== undefined && state?.result?.outcome === "done") return { key: storedRequest(existing)!.outputs[0]!.storageKey };
    const built = existing === undefined ? await planned.build() : null;
    const candidate: MiniToolPlanJobRequest = existing === undefined
      ? { schemaVersion: 2, jobId, containerClass, deadlineAt, limits: run.container.limits, inputs: built!.inputs,
        outputs: [{ outputIndex: 0, storageKey: videoPresentationWorkKeyFor(run.sourceKey, jobId), contentType: planned.contentType, recipe: built!.recipe }] }
      : storedRequest(existing)!;
    const step = existing ?? await appendStep(run.taskId, { kind: "container_job", endpoint: containerClass, itemIndex: steps.length });
    const { request, consumption } = await openMiniToolPlanJob({ taskId: run.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: "user", request: candidate });
    const report = readMiniToolPlanJobReport(request, await advanceMiniToolPlanJob(request));
    if (report.state !== "done" && report.state !== "failed") throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
    const output = request.outputs[0]!.storageKey;
    await recordMiniToolStepResult({ taskId: run.taskId, stepId: step.id, identity: consumption.identity, outcome: report.state, result: report,
      ...(report.state === "failed" ? { error: { code: report.reason }, presentation: { retire: [output] } } : { presentation: { pin: [output] } }) },
    { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(request, value) });
    if (report.state === "done") return { key: output };
    reason = report.reason;
  }
  return planned.failed(reason);
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
 * Read a run's frozen full ledger; one that fails its receipt fails the run (§91 D3b-9).
 * @param run - The run.
 * @param receipt - The frozen receipt.
 * @param deadlineAt - The task deadline.
 * @returns The ledger.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when the ledger fails its receipt.
 * @throws {Error} When the read fails in transport.
 */
export async function runLedger(run: ModelStepRun, receipt: VideoPresentationLedgerReceipt, deadlineAt: number): Promise<VideoPresentationLedger> {
  try {
    return await readJobLedger(receipt, deadlineAt);
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    logger.error({ err: error, ctx: { taskId: run.taskId } }, `mini_tool_${run.log}_ledger_invalid`);
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
}

/**
 * Advance every chunk step, each submitted before the pickup waits on any (frames-split §5.4).
 * @param run - The run.
 * @param chunks - The chunk steps in order.
 * @param deadlineAt - The task deadline.
 * @returns Every chunk's output in order, or the first failure.
 * @throws {StillRunning} While a chunk runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceChunks(run: ModelStepRun, chunks: readonly ContainerStep[], deadlineAt: number): Promise<{ keys: string[] } | Exclude<StepEnded, { key: string }>> {
  const keys: string[] = [];
  let running = false;
  for (const chunk of chunks) {
    let ended: StepEnded;
    try { ended = await advanceContainer(run, chunk, deadlineAt); } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      running = true;
      continue;
    }
    if (!("key" in ended)) return ended;
    keys.push(ended.key);
  }
  if (running) throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
  return { keys };
}

/** A run's one registered output job. */
export interface RegisteredStep {
  stepKey: string;
  /** The output's upload name prefix. */
  namePrefix: string;
  container: "mp4" | "webm";
  build: () => Promise<{ recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }>;
}

/**
 * Advance the job that writes the run's one registered output, up to the frozen retries.
 * @param run - The run.
 * @param planned - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The registered output, or null when every attempt failed.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When persistence, grants or registration fail.
 */
export async function advanceRegistered(run: ModelStepRun, planned: RegisteredStep, userId: string, deadlineAt: number): Promise<MiniToolExecutionRegistered | null> {
  for (let attempt = 1; attempt <= run.container.chunkRetries + 1; attempt += 1) {
    const jobId = `${run.taskId}:${planned.stepKey}:a${attempt}`;
    const steps = await upstreamStepRepo.listSteps(run.taskId);
    let step = steps.find((candidate) => storedRequest(candidate)?.jobId === jobId);
    let request = step === undefined ? null : storedRequest(step);
    if (request === null) {
      const built = await planned.build();
      const [grant] = await openContainerOutputs({ projectId: run.projectId, actingUserId: userId, taskId: run.taskId, deadlineAt,
        outputs: [{ modality: "video", namePrefix: planned.namePrefix, ...(planned.container === "webm" ? { container: "webm" as const } : {}) }] });
      if (grant === undefined) throw new Error(`The ${run.log} output requires its upload grant`);
      request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId, containerClass: run.container.containerClass, deadlineAt, limits: run.container.limits,
        inputs: built.inputs, outputs: [{ ...grant, outputIndex: 0, recipe: built.recipe }] });
      step = await appendStep(run.taskId, { kind: "container_job", endpoint: run.container.containerClass, itemIndex: steps.length });
    }
    const job = await advanceRegisteredMiniToolPlanJob({ taskId: run.taskId, stepId: step!.id, chunkIndex: step!.position, chargeTo: "user", request });
    const written = job.assets.find((entry) => entry.outputIndex === 0);
    if (job.report.state === "done" && written !== undefined) return await registered(written.asset) as MiniToolExecutionRegistered;
  }
  return null;
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

/** A tracking clip to prepare: its presentation frames, its order and the step key of its prepared video. */
export interface ClipStep {
  stepKey: string;
  clip: { start: number; end: number };
  order: "forward" | "reverse";
  ledger: VideoPresentationLedger;
  target: MiniToolPlanTarget;
  /** The failed line of a job that failed for good. */
  failed: (reason: string) => StepEnded;
}

/**
 * Prepare a tracking clip (execution design §10.2): one `prepare_model_input` job, or, for a reversed clip whose decoded
 * frames pass `encoding.reverse_buffer_bytes`, one reversed job per chunk of at most that many frames and a stitch that
 * joins them latest chunk first, so the k-th chunk of the reversed clip is the (n − 1 − k)-th of the forward one.
 * @param run - The run.
 * @param planned - The clip.
 * @param deadlineAt - The task deadline.
 * @returns The prepared video, or the failure.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
export async function advanceClip(run: ModelStepRun, planned: ClipStep, deadlineAt: number): Promise<StepEnded> {
  const { ledger, target, clip, order } = planned;
  const source = "00000000-0000-4000-8000-000000000001";
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
    build: () => Promise.resolve({ recipe: { kind: "prepare_model_input", inputId: source, window, timescale: ledger.plan.presentation.timescale,
      entries: windowEntries(ledger, window), target, audio: null, order }, inputs: [{ inputId: source, storageKey: run.sourceKey }] }) });
  // The reverse filter holds every decoded frame of its window, 8-bit 4:2:0 at the target size.
  const most = Math.max(1, Math.floor(getMiniToolsConfig().encoding.reverse_buffer_bytes / (target.width * target.height * 1.5)));
  if (order === "forward" || clip.end - clip.start <= most) return advanceContainer(run, prepare(clip, planned.stepKey), deadlineAt);
  const windows: { start: number; end: number }[] = [];
  for (let start = clip.start; start < clip.end; start += most) windows.push({ start, end: Math.min(clip.end, start + most) });
  // A chunk's key is the clip's with its index, so no chunk is found again as the whole clip.
  const chunks = await advanceChunks(run, windows.map((window, k) => prepare(window, `${planned.stepKey}.c${k}`)), deadlineAt);
  if (!("keys" in chunks)) return chunks;
  const latestFirst = windows.map((window, k) => ({ window, key: chunks.keys[k]! })).reverse();
  return advanceContainer(run, { stepKey: planned.stepKey, contentType: "video/mp4", failed: planned.failed,
    build: () => Promise.resolve({ recipe: { kind: "stitch", inputId: source, target, audio: null,
      chunks: latestFirst.map((chunk, at) => ({ inputId: chunkInputId(at), duration: windowDuration(ledger, chunk.window) })) },
    inputs: [{ inputId: source, storageKey: run.sourceKey }, ...latestFirst.map((chunk, at) => ({ inputId: chunkInputId(at), storageKey: chunk.key }))] }) }, deadlineAt);
}
