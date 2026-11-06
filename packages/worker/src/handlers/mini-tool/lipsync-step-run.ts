// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One lip-sync step on the frozen plan (multi-person lip-sync DD §7.2): prepare, a person's track, faces, clip, stem and
 * gen, then the shared composite and stitch. The runner (`run-lip-sync.ts`) calls it each pickup; a finished step answers
 * `done` again without being redone.
 *
 * - prepare: the model-input preparation of the used source range (the removal's preparation, frames-split §5.3).
 * - track, gen: `generate` steps (execution design §9.1, §9.3), the submit intent stored before the provider is called; the
 *   provider's temporary link is fetched by the ingest Worker into `${stepKey}:${attemptId}` (§97 D21-1), recorded with
 *   the step result and appended to the run's execution pin in that transaction, with no asset row.
 * - faces, clip, stem, composite: standard-4 container jobs with the §7.17 recipes; the job id is
 *   `${taskId}:${stepKey}:a${attempt}` (a composite chunk adds `:c${chunk}`), the output key
 *   `videoPresentationWorkKeyFor(sourceKey, jobId)` (§97 D21-2), pinned with the run; retried up to the frozen
 *   `chunkRetries`. Every stage runs one job per person or chunk, so no stage sends more than its frozen `stageJobs`.
 * - stitch: one registered job over the composite chunks with every person's stem summed (§97 D22-3).
 * - a retry finds each done step of the original run by its frozen step key and reuses its object (§97 D21-6).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getMiniToolsConfig, getRawEnvVar, getStorageAdapter, logger } from "@breatic/core";
import {
  backendUploadService, beginMiniToolStepAttempt, lipsyncPersonStepKeys, lipsyncStepKey, failMiniToolStep, getFullModelConfig, miniToolStepStateSchema, openContainerOutputs, openMiniToolPlanJob,
  recordMiniToolStepIdentity, recordMiniToolStepResult, taskRepo, upstreamStepRepo, type AcceptedMiniToolExecution, type MiniToolStepJson,
} from "@breatic/domain";
import {
  miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, videoPresentationWorkKeyFor, type MiniToolPlanExact, type MiniToolPlanJobRequest,
  type MiniToolPlanRecipe, type MiniToolPlanTarget, type VideoPresentationLedger,
} from "@breatic/shared";
import { presentationFrameCount, type MiniToolExecutionRegistered } from "@breatic/shared/mini-tools";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { lipsyncFacesFailureLine, lipsyncObjectKey, lipsyncStepCategory, type LipsyncAsyncRejection } from "@worker/handlers/mini-tool/lipsync-steps.js";
import { appendStep, prepareModelInput, preparedRequest, type PreparingRun } from "@worker/handlers/mini-tool/prepare-model-input.js";
import { advanceRegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { registered } from "@worker/handlers/mini-tool/run-video-tool.js";
import { chunkInputId, FullLedgerInvalid, readJobLedger, segmentTarget, windowEntries } from "@worker/handlers/video-presentation-recipes.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { runPrediction } from "@worker/providers/wavespeed.js";

/** A lip-sync step kind in stage order. */
export type LipSyncStepKind = "prepare" | "track" | "faces" | "clip" | "stem" | "gen" | "composite" | "stitch";
/** One step: a person's (personId set) or a shared one (null). */
export interface LipSyncStep { kind: LipSyncStepKind; personId: string | null }
/** What a step reached; the stitch's `done` carries the registered output. */
export type LipSyncStepOutcome =
  | { state: "done"; result?: MiniToolExecutionRegistered }
  | { state: "running" }
  /** A failed step names the step its line is written under: a faces job that found no tracked foreground names track (§97 D21-5). */
  | { state: "failed"; step: LipSyncStepKind; category: "no_face" | "model_rejected" | "timeout" | "failed" };

type LipSync = Extract<AcceptedMiniToolExecution, { tool: "video.lip-sync" }>;
type Step = Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number];
type Category = Extract<LipSyncStepOutcome, { state: "failed" }>["category"];
/** A step that ended: its object key, or why it failed. */
type Ended = { key: string } | { failed: Category; step?: LipSyncStepKind };

/** The input ids a recipe binds its objects under, fixed per role and index so a rebuilt request is the same request. */
const SOURCE = "00000000-0000-4000-8000-000000000001";
const PREPARED = "00000000-0000-4000-8000-000000000002";
/**
 * A fixed input id for a role and an index.
 * @param role - The role's two digits.
 * @param index - The person, chunk or row.
 * @returns A UUID.
 * @throws {never} Never.
 */
const inputOf = (role: number, index: number): string => `00000000-0000-4000-80${String(role).padStart(2, "0")}-${String(index).padStart(12, "0")}`;
const TRACK = 2;
const FACES = 3;
const RESULT = 4;
const ROW = 5;
const STEM = 6;

const trackOutputs = z.tuple([z.object({ rle_url: z.url() })]);
const genOutputs = z.tuple([z.url()]);
const objectResult = z.strictObject({ stepKey: z.string().min(1), object: z.string().min(1), providerURL: z.url() });

const retryOf = z.object({ miniToolExecution: z.object({ retry: z.object({ runId: z.uuid() }).optional() }) });

/**
 * The runs whose steps this run may use: itself, then each earlier run its retry chain names (§97 D21-6).
 * @param execution - The frozen run.
 * @returns The task ids, this run first.
 * @throws {Error} When a run of the chain cannot be read.
 */
async function runsOf(execution: LipSync): Promise<string[]> {
  const runs = [execution.taskId];
  let next = execution.retry?.runId;
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
function storedRequest(step: Step): MiniToolPlanJobRequest | null {
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
 * The object of a done step of the original run, found by its frozen step key: a generate step's derived object, or a
 * container job's output.
 * @param execution - The frozen run.
 * @param stepKey - The step key.
 * @returns The key, or null.
 * @throws {Error} When the step read fails.
 */
async function reused(execution: LipSync, stepKey: string): Promise<string | null> {
  for (const run of (await runsOf(execution)).slice(1)) {
    for (const step of await upstreamStepRepo.listSteps(run)) {
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
 * The prepared video's done request, in this run or the original run.
 * @param execution - The frozen run.
 * @returns The request.
 * @throws {Error} When no preparation is done, or the read fails.
 */
async function preparedOf(execution: LipSync): Promise<MiniToolPlanJobRequest> {
  const single = execution.layout.preparation.length === 1;
  for (const run of await runsOf(execution)) {
    const request = await preparedRequest(run, single);
    if (request !== null) return request;
  }
  throw new Error("The lip-sync run has no prepared video");
}

/**
 * Read the frozen full ledger; one that fails its receipt fails the run (§91 D3b-9).
 * @param execution - The frozen run.
 * @param deadlineAt - The task deadline.
 * @returns The ledger.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when the ledger fails its receipt.
 * @throws {Error} When the read fails in transport.
 */
async function ledgerOf(execution: LipSync, deadlineAt: number): Promise<VideoPresentationLedger> {
  try {
    return await readJobLedger(execution.ledgerReceipts.source, deadlineAt);
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    logger.error({ err: error, ctx: { taskId: execution.taskId } }, "mini_tool_lipsync_ledger_invalid");
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
}

/**
 * The reduced exact time of seconds written in decimal.
 * @param seconds - The seconds.
 * @returns The exact time.
 * @throws {RangeError} When the number is negative, not finite or only writable in exponent form.
 */
function exactSeconds(seconds: number): MiniToolPlanExact {
  const text = String(seconds);
  if (!Number.isFinite(seconds) || seconds < 0 || text.includes("e")) throw new RangeError(`${text} seconds have no exact decimal form`);
  const [whole, fraction = ""] = text.split(".");
  return exact(BigInt(whole! + fraction), 10n ** BigInt(fraction.length));
}

/**
 * A reduced exact fraction.
 * @param numerator - The numerator.
 * @param denominator - The positive denominator.
 * @returns The exact time.
 * @throws {never} Never.
 */
function exact(numerator: bigint, denominator: bigint): MiniToolPlanExact {
  let [a, b] = [numerator < 0n ? -numerator : numerator, denominator];
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a === 0n ? denominator : a;
  return { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
}

/**
 * A catalog model's WaveSpeed model id.
 * @param name - The catalog model.
 * @returns Its provider model id.
 * @throws {Error} When the catalog offers it through no WaveSpeed upstream.
 */
function providerModel(name: string): string {
  const model = getFullModelConfig("video").models.find((candidate) => candidate.name === name);
  const id = model?.providers?.find((provider) => provider.name === "wavespeed")?.model_id;
  if (typeof id !== "string") throw new Error(`The model ${name} has no WaveSpeed upstream`);
  return id;
}

/** One generate step's identity and request. */
interface Generate {
  kind: "track" | "gen";
  endpoint: string;
  itemIndex: number;
  stepKey: string;
  contentType: string;
  body: () => Promise<Record<string, MiniToolStepJson>>;
  link: (outputs: unknown) => string | null;
  rejection: LipsyncAsyncRejection | undefined;
}

/**
 * Advance a `generate` step: reuse its done object, submit it once under a stored intent, or ask for its stored prediction;
 * once the provider returned, fetch its link into the derived key and record it with the pin in one transaction.
 * @param execution - The frozen run.
 * @param planned - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The object, or the failure category.
 * @throws {StillRunning} While the prediction runs.
 * @throws {Error} When persistence or the link fetch fails.
 */
async function advanceGenerate(execution: LipSync, planned: Generate, userId: string, deadlineAt: number): Promise<Ended> {
  const steps = await upstreamStepRepo.listSteps(execution.taskId);
  let step = steps.find((candidate) => candidate.kind === "generate" && candidate.endpoint === planned.endpoint && candidate.itemIndex === planned.itemIndex);
  if (step === undefined) {
    const original = await reused(execution, planned.stepKey);
    if (original !== null) return { key: original };
    step = await appendStep(execution.taskId, { kind: "generate", endpoint: planned.endpoint, itemIndex: planned.itemIndex });
  }
  let state = stateOf(step);
  if (state?.result?.outcome === "done") return { key: objectResult.parse(state.result.result).object };
  if (step.status === "failed") return { failed: z.enum(["model_rejected", "timeout", "failed"]).catch("failed").parse(state?.error?.code) };
  const connection = getFullModelConfig("video").providers.wavespeed;
  const apiKey = getRawEnvVar(connection?.api_key_env ?? "");
  if (!connection?.base_url || !apiKey) throw new Error("The WaveSpeed connection is unavailable");
  let attemptId = state?.attempts.find((attempt) => attempt.resolution.kind === "identity" && attempt.resolution.predictionId === step!.predictionId)?.attemptId ?? null;
  let submitted = false;
  if (step.predictionId === null) {
    const prepared = await beginMiniToolStepAttempt({ taskId: execution.taskId, stepId: step.id, attemptId: randomUUID(),
      requestBody: state?.requestBody ?? await planned.body(), deadlineAt: state?.deadlineAt ?? deadlineAt, chargeTo: "user" });
    if (!prepared.shouldSubmit || prepared.attempt === null) throw new Error("The lip-sync submit intent requires reconciliation");
    attemptId = prepared.attempt.attemptId;
    step = prepared.step;
    state = stateOf(step);
  }
  if (attemptId === null || state === null || state.requestBody === null) throw new Error("The lip-sync step has no stored submit intent");
  const owned = step;
  const attempt = attemptId;
  let prediction: Awaited<ReturnType<typeof runPrediction>>;
  try {
    prediction = await runPrediction({ baseUrl: connection.base_url, apiKey }, planned.endpoint, state.requestBody, {
      storedTaskId: owned.predictionId, externalTaskId: owned.id, retryStarting: false, deadlineAt: state.deadlineAt ?? deadlineAt,
      persistTaskId: async (predictionId): Promise<void> => {
        const receipt = await recordMiniToolStepIdentity({ taskId: execution.taskId, stepId: owned.id, attemptId: attempt, predictionId });
        if (receipt.conflict) throw new Error("Provider receipt conflicts with its original prediction");
        submitted = true;
      },
    });
  } catch (error) {
    if (error instanceof StillRunning) throw error;
    const category = lipsyncStepCategory(planned.kind, error, planned.rejection);
    logger.error({ err: error, ctx: { taskId: execution.taskId, stepId: owned.id, step: planned.kind, category } }, "mini_tool_lipsync_provider_failed");
    // A refusal answered before any prediction existed proves this attempt was never accepted.
    const refused = error instanceof HttpStatusError && owned.predictionId === null && !submitted;
    await failMiniToolStep({ taskId: execution.taskId, stepId: owned.id, error: { code: category, message: error instanceof Error ? error.message : String(error) },
      ...(refused ? { attempt: { attemptId: attempt, proof: "rejected" as const } } : {}) });
    return { failed: category };
  }
  const link = planned.link(prediction.outputs);
  if (link === null) {
    logger.error({ ctx: { taskId: execution.taskId, stepId: owned.id, step: planned.kind } }, "mini_tool_lipsync_provider_output_unreadable");
    await failMiniToolStep({ taskId: execution.taskId, stepId: owned.id, error: { code: "failed", message: "The provider answered no readable link" } });
    return { failed: "failed" };
  }
  const key = lipsyncObjectKey(planned.stepKey, attempt);
  await backendUploadService.transferUrlToDerived(link, { storageKey: key, contentType: planned.contentType, projectId: execution.projectId, actingUserId: userId,
    deadlineAt: state.deadlineAt ?? deadlineAt });
  await recordMiniToolStepResult({ taskId: execution.taskId, stepId: owned.id, identity: { kind: "provider", provider: "wavespeed", predictionId: prediction.taskId },
    outcome: "done", result: { stepKey: planned.stepKey, object: key, providerURL: link }, presentation: { pin: [key] } },
  { kind: "generate", parse: (value) => objectResult.parse(value) });
  return { key };
}

/** One container step's identity and request. */
interface Container {
  stepKey: string;
  /** The job id of an attempt. */
  jobId: (attempt: number) => string;
  contentType: string;
  build: () => Promise<{ recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }>;
  /** The failed line of a job that failed for good. */
  failed: (reason: string) => Ended;
}

/**
 * Advance a container step: reuse its done output, or run its attempts up to the frozen retries, the output pinned with
 * the run and a failed attempt's output retired.
 * @param execution - The frozen run.
 * @param planned - The step.
 * @param deadlineAt - The task deadline.
 * @returns The output, or the failure.
 * @throws {StillRunning} While a job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
async function advanceContainer(execution: LipSync, planned: Container, deadlineAt: number): Promise<Ended> {
  let reason = "tool_failed";
  for (let attempt = 1; attempt <= execution.container.chunkRetries + 1; attempt += 1) {
    const jobId = planned.jobId(attempt);
    const steps = await upstreamStepRepo.listSteps(execution.taskId);
    const existing = steps.find((step) => storedRequest(step)?.jobId === jobId);
    if (existing === undefined && attempt === 1) {
      const original = await reused(execution, planned.stepKey);
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
      ? { schemaVersion: 2, jobId, containerClass: execution.container.containerClass, deadlineAt, limits: execution.container.limits, inputs: built!.inputs,
        outputs: [{ outputIndex: 0, storageKey: videoPresentationWorkKeyFor(execution.sourceKey, jobId), contentType: planned.contentType, recipe: built!.recipe }] }
      : storedRequest(existing)!;
    const step = existing ?? await appendStep(execution.taskId, { kind: "container_job", endpoint: execution.container.containerClass, itemIndex: steps.length });
    const { request, consumption } = await openMiniToolPlanJob({ taskId: execution.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: "user", request: candidate });
    const report = readMiniToolPlanJobReport(request, await advanceMiniToolPlanJob(request));
    if (report.state !== "done" && report.state !== "failed") throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
    const output = request.outputs[0]!.storageKey;
    await recordMiniToolStepResult({ taskId: execution.taskId, stepId: step.id, identity: consumption.identity, outcome: report.state, result: report,
      ...(report.state === "failed" ? { error: { code: report.reason }, presentation: { retire: [output] } } : { presentation: { pin: [output] } }) },
    { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(request, value) });
    if (report.state === "done") return { key: output };
    reason = report.reason;
  }
  return planned.failed(reason);
}

/**
 * A person of the frozen run and the frozen step keys every person carries (DD §7.1 persons row).
 * @param execution - The frozen run.
 * @param personId - The person.
 * @returns The person, its position and its step keys.
 * @throws {Error} When the run names no such person.
 */
function personOf(execution: LipSync, personId: string | null): { index: number; keys: Record<"track" | "faces" | "clip" | "stem" | "gen", string> } {
  const index = execution.persons.findIndex((person) => person.personId === personId);
  const person = execution.persons[index];
  if (person === undefined) throw new Error(`The lip-sync run has no person ${personId}`);
  return { index, keys: lipsyncPersonStepKeys(execution.planFingerprint, person) };
}

/**
 * A person's done object of an earlier stage.
 * @param execution - The frozen run.
 * @param personId - The person.
 * @param kind - The earlier step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns Its key.
 * @throws {Error} When that step is not done.
 */
async function objectOf(execution: LipSync, personId: string, kind: "track" | "faces" | "clip" | "stem" | "gen", userId: string, deadlineAt: number): Promise<string> {
  const ended = await personStep(execution, kind, personId, userId, deadlineAt);
  if (!("key" in ended)) throw new Error(`The lip-sync ${kind} of ${personId} is not done`);
  return ended.key;
}

/**
 * A container step of one person.
 * @param execution - The frozen run.
 * @param stepKey - The step key.
 * @param contentType - The output's type.
 * @param build - The recipe and its inputs.
 * @param failed - The failed line of a job that failed for good.
 * @param deadlineAt - The task deadline.
 * @returns The output, or the failure.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When persistence or the job boundary fails.
 */
async function personContainer(execution: LipSync, stepKey: string, contentType: string, build: Container["build"], failed: Container["failed"], deadlineAt: number): Promise<Ended> {
  return advanceContainer(execution, { stepKey, jobId: (attempt) => `${execution.taskId}:${stepKey}:a${attempt}`, contentType, build, failed }, deadlineAt);
}

/**
 * Advance one person's step.
 * @param execution - The frozen run.
 * @param kind - The step.
 * @param personId - The person.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The object, or the failure.
 * @throws {StillRunning} While the step runs.
 * @throws {Error} When an earlier step is not done, or persistence or IO fails.
 */
async function personStep(execution: LipSync, kind: "track" | "faces" | "clip" | "stem" | "gen", personId: string, userId: string, deadlineAt: number): Promise<Ended> {
  const { index, keys } = personOf(execution, personId);
  const person = execution.persons[index]!;
  const storage = await getStorageAdapter();
  switch (kind) {
    case "track":
      return advanceGenerate(execution, { kind, endpoint: providerModel(execution.tracking.model), itemIndex: index, stepKey: keys.track, contentType: "application/json",
        rejection: undefined, link: (outputs) => { const parsed = trackOutputs.safeParse(outputs); return parsed.success ? parsed.data[0].rle_url : null; },
        body: async () => {
          // §97 D21-4: one box in the prepared video's pixels on its anchor frame; the RLE is read, so no mask is applied.
          const request = await preparedOf(execution);
          const { target } = request.outputs[0]!.recipe as { target: MiniToolPlanTarget };
          const rect = target.displayRect ?? { x: 0, y: 0, width: target.width, height: target.height };
          const box = person.anchorFaceBox;
          return { video: storage.publicUrl(request.outputs[0]!.storageKey), apply_mask: false, box_prompts: [{
            frame_index: person.anchor.frameIndex, object_id: 1,
            x_min: Math.round(rect.x + box.x * rect.width), y_min: Math.round(rect.y + box.y * rect.height),
            x_max: Math.round(rect.x + (box.x + box.width) * rect.width), y_max: Math.round(rect.y + (box.y + box.height) * rect.height) }] };
        } }, userId, deadlineAt);
    case "faces":
      return personContainer(execution, keys.faces, "application/json", async () => {
        const [prepared, track] = [(await preparedOf(execution)).outputs[0]!.storageKey, await objectOf(execution, personId, "track", userId, deadlineAt)];
        return { recipe: { kind: "lipsync_faces", inputId: PREPARED, track: inputOf(TRACK, 0), profile: getMiniToolsConfig().analyses.people.profile },
          inputs: [{ inputId: PREPARED, storageKey: prepared }, { inputId: inputOf(TRACK, 0), storageKey: track }] };
      }, (reason) => { const line = lipsyncFacesFailureLine(reason); return { failed: line.category as Category, step: line.step }; }, deadlineAt);
    case "clip":
      return personContainer(execution, keys.clip, "video/mp4", async () => {
        const ledger = await ledgerOf(execution, deadlineAt);
        const inputs = [{ inputId: PREPARED, storageKey: (await preparedOf(execution)).outputs[0]!.storageKey },
          { inputId: inputOf(FACES, 0), storageKey: await objectOf(execution, personId, "faces", userId, deadlineAt) },
          { inputId: inputOf(TRACK, 0), storageKey: await objectOf(execution, personId, "track", userId, deadlineAt) }];
        return { recipe: { kind: "lipsync_clip", inputId: PREPARED, faces: inputOf(FACES, 0), track: inputOf(TRACK, 0), cropSize: execution.cropSize,
          timeline: execution.timeline, table: ledger.plan.presentation }, inputs };
      }, () => ({ failed: "failed" }), deadlineAt);
    case "stem":
      return personContainer(execution, keys.stem, "audio/mp4", async () => {
        const draft = execution.draft as { inputs?: { inputId: string; url: string }[] };
        const rows = execution.dialogues.filter((row) => row.personId === personId).map((row, at) => {
          const url = draft.inputs?.find((input) => input.inputId === row.audioInputId)?.url;
          const storageKey = url === undefined ? null : storage.keyFromUrl(url);
          if (storageKey === null) throw new Error(`The lip-sync row ${row.dialogueId} has no stored audio`);
          return { inputId: inputOf(ROW, at), storageKey, startTime: exactSeconds(row.startTime) };
        });
        return { recipe: { kind: "lipsync_stem", rows: rows.map((row) => ({ inputId: row.inputId, startTime: row.startTime })), duration: exactSeconds(execution.timeline.duration) },
          inputs: rows.map((row) => ({ inputId: row.inputId, storageKey: row.storageKey })) };
      }, () => ({ failed: "failed" }), deadlineAt);
    case "gen": {
      const model = getMiniToolsConfig().executions["video.lip-sync"]?.models.find((candidate) => candidate.name === execution.generator.modelId);
      return advanceGenerate(execution, { kind, endpoint: providerModel(execution.generator.modelId), itemIndex: index, stepKey: keys.gen, contentType: "video/mp4",
        rejection: model?.async_rejection, link: (outputs) => { const parsed = genOutputs.safeParse(outputs); return parsed.success ? parsed.data[0] : null; },
        body: async () => ({
          video: storage.publicUrl(await objectOf(execution, personId, "clip", userId, deadlineAt)),
          audio: storage.publicUrl(await objectOf(execution, personId, "stem", userId, deadlineAt)),
          // §9.3: only a model that accepts it is told to cut the result off at the audio's end.
          ...(execution.generator.providerSyncMode === "cut_off" ? { sync_mode: "cut_off" } : {}),
        }) }, userId, deadlineAt);
    }
  }
}

/**
 * The composite chunks over every person's result, faces table and track (§7.17 lipsync_composite row).
 * @param execution - The frozen run.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns Every chunk's output in order, or the failure.
 * @throws {StillRunning} While a chunk runs.
 * @throws {Error} When persistence or IO fails.
 */
async function composite(execution: LipSync, userId: string, deadlineAt: number): Promise<{ keys: string[] } | { failed: Category }> {
  const stepKey = lipsyncStepKey(execution.planFingerprint, null, "composite");
  const keys: string[] = [];
  let running = false;
  for (const [chunk, window] of execution.layout.composite.entries()) {
    let ended: Ended;
    try {
      ended = await advanceContainer(execution, { stepKey: `${stepKey}:c${chunk}`, jobId: (attempt) => `${execution.taskId}:${stepKey}:c${chunk}:a${attempt}`, contentType: "video/mp4",
        failed: () => ({ failed: "failed" }), build: async () => {
          const ledger = await ledgerOf(execution, deadlineAt);
          const persons = await Promise.all(execution.persons.map(async (person, at) => ({
            ids: { result: inputOf(RESULT, at), faces: inputOf(FACES, at), track: inputOf(TRACK, at) },
            keys: { result: await objectOf(execution, person.personId, "gen", userId, deadlineAt), faces: await objectOf(execution, person.personId, "faces", userId, deadlineAt),
              track: await objectOf(execution, person.personId, "track", userId, deadlineAt) } })));
          const target = segmentTarget(ledger, execution.container.encode);
          return { recipe: { kind: "lipsync_composite", inputId: SOURCE, window: { start: window.start, end: window.end }, timescale: ledger.plan.presentation.timescale,
            entries: windowEntries(ledger, { start: 0, end: presentationFrameCount(ledger.plan.presentation) }), target: { ...target, format: undefined },
            timeline: execution.timeline, table: ledger.plan.presentation, persons: persons.map((person) => ({ ...person.ids, cropSize: execution.cropSize })) },
          inputs: [{ inputId: SOURCE, storageKey: execution.sourceKey }, ...persons.flatMap((person) => (["result", "faces", "track"] as const)
            .map((role) => ({ inputId: person.ids[role], storageKey: person.keys[role] })))] };
        } }, deadlineAt);
    } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      running = true;
      continue;
    }
    if (!("key" in ended)) return { failed: ended.failed };
    keys.push(ended.key);
  }
  if (running) throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
  return { keys };
}

/**
 * The one registered stitch over the composite chunks, its audio every person's stem summed (§97 D22-3).
 * @param execution - The frozen run.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The registered output, or the failure.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When persistence, grants or registration fail.
 */
async function stitch(execution: LipSync, userId: string, deadlineAt: number): Promise<LipSyncStepOutcome> {
  const chunks = await composite(execution, userId, deadlineAt);
  if (!("keys" in chunks)) return { state: "failed", step: "stitch", category: chunks.failed };
  const stepKey = lipsyncStepKey(execution.planFingerprint, null, "composite");
  for (let attempt = 1; attempt <= execution.container.chunkRetries + 1; attempt += 1) {
    const jobId = `${execution.taskId}:${stepKey}:stitch:a${attempt}`;
    const steps = await upstreamStepRepo.listSteps(execution.taskId);
    let step = steps.find((candidate) => storedRequest(candidate)?.jobId === jobId);
    let request = step === undefined ? null : storedRequest(step);
    if (request === null) {
      const ledger = await ledgerOf(execution, deadlineAt);
      const table = ledger.plan.presentation;
      const step0 = table.runs[0]!.step;
      const stems = await Promise.all(execution.persons.map(async (person) => objectOf(execution, person.personId, "stem", userId, deadlineAt)));
      const target = segmentTarget(ledger, execution.container.encode);
      const [grant] = await openContainerOutputs({ projectId: execution.projectId, actingUserId: userId, taskId: execution.taskId, deadlineAt,
        outputs: [{ modality: "video", namePrefix: "LIPSYNC", ...(target.format === "webm-vp9" ? { container: "webm" as const } : {}) }] });
      if (grant === undefined) throw new Error("The lip-sync output requires its upload grant");
      request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId, containerClass: execution.container.containerClass, deadlineAt, limits: execution.container.limits,
        inputs: [{ inputId: SOURCE, storageKey: execution.sourceKey }, ...chunks.keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey })),
          ...stems.map((storageKey, at) => ({ inputId: inputOf(STEM, at), storageKey }))],
        outputs: [{ ...grant, outputIndex: 0, recipe: { kind: "stitch", inputId: SOURCE, target,
          chunks: execution.layout.composite.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: exact(BigInt((window.end - window.start) * step0), BigInt(table.timescale)) })),
          audio: { kind: "mix", inputs: stems.map((_key, at) => inputOf(STEM, at)) } } }] });
      step = await appendStep(execution.taskId, { kind: "container_job", endpoint: execution.container.containerClass, itemIndex: steps.length });
    }
    const job = await advanceRegisteredMiniToolPlanJob({ taskId: execution.taskId, stepId: step!.id, chunkIndex: step!.position, chargeTo: "user", request });
    const written = job.assets.find((entry) => entry.outputIndex === 0);
    if (job.report.state === "done" && written !== undefined) return { state: "done", result: await registered(written.asset) as MiniToolExecutionRegistered };
  }
  return { state: "failed", step: "stitch", category: "failed" };
}

/**
 * Advance one step.
 * @param execution - The frozen run.
 * @param step - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The step's outcome.
 * @throws {Error} When an earlier step is not done, or persistence, grants, registration or IO fail.
 */
export async function runLipSyncStep(execution: unknown, step: LipSyncStep, userId: string, deadlineAt: number): Promise<LipSyncStepOutcome> {
  const run = execution as LipSync;
  try {
    if (step.kind === "prepare") {
      const preparing: PreparingRun = { taskId: run.taskId, sourceKey: run.sourceKey, ledgerReceipts: run.ledgerReceipts, presentationRef: run.presentationRef,
        preparation: { ...run.container, chunks: run.layout.preparation } };
      // A retry reuses the preparation of its chain's original run (frames-split §7.11 retry row).
      for (const owner of (await runsOf(run)).slice(1)) if (await preparedRequest(owner, run.layout.preparation.length === 1) !== null) return { state: "done" };
      await prepareModelInput(preparing, deadlineAt);
      return { state: "done" };
    }
    if (step.kind === "composite") {
      const chunks = await composite(run, userId, deadlineAt);
      return "keys" in chunks ? { state: "done" } : { state: "failed", step: "composite", category: chunks.failed };
    }
    if (step.kind === "stitch") return await stitch(run, userId, deadlineAt);
    if (step.personId === null) throw new Error(`The lip-sync ${step.kind} step belongs to a person`);
    const ended = await personStep(run, step.kind, step.personId, userId, deadlineAt);
    return "key" in ended ? { state: "done" } : { state: "failed", step: ended.step ?? step.kind, category: ended.failed };
  } catch (error) {
    if (error instanceof StillRunning) return { state: "running" };
    // Only the preparation and the ledger read throw this here; a provider's failure is caught where it is called.
    if (error instanceof UpstreamTaskFailed) {
      logger.error({ err: error, ctx: { taskId: run.taskId, step: step.kind } }, "mini_tool_lipsync_step_failed");
      return { state: "failed", step: step.kind, category: "failed" };
    }
    throw error;
  }
}
