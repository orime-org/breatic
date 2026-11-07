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
  backendUploadService, beginMiniToolStepAttempt, failMiniToolStep, getFullModelConfig, miniToolStepStateSchema, openMiniToolPlanJob, recordMiniToolStepIdentity,
  recordMiniToolStepResult, taskRepo, upstreamStepRepo, type FullModelEntry, type MiniToolStepJson,
} from "@breatic/domain";
import {
  DeadlinePassed, HttpRetryError, miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, videoPresentationWorkKeyFor, type MiniToolPlanJobRequest, type MiniToolPlanRecipe,
} from "@breatic/shared";
import type { ExpandFailureReason } from "@breatic/shared/mini-tools";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { appendStep } from "@worker/handlers/mini-tool/prepare-model-input.js";
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
