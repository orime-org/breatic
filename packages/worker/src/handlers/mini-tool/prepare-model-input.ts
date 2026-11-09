// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model-input preparation of a planned removal (inner#1306; frames-split design §5.3 model-input row, §5.4 job identities,
 * §7.1.1): before `generate`, the frozen preparation runs as standard-4 `container_job` steps — one `prepare_model_input`
 * job over the whole presentation window, or `chunk_encode` jobs plus a `stitch` — each attempt under its §5.4 id, its
 * output key from the shared key function and its expense opened with the step. A failed attempt is retried under the
 * next attempt's id up to the configured chunk retries. A failed-output retry reuses the original run's prepared object.
 */

import { getMiniToolsConfig, logger } from "@breatic/core";
import {
  miniToolStepStateSchema, openMiniToolPlanJob, recordMiniToolStepResult, upstreamStepRepo,
  type AcceptedMiniToolExecution,
} from "@breatic/domain";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, videoPresentationWorkKeyFor, type MiniToolPlanJobRequest, type MiniToolPlanRecipe } from "@breatic/shared";
import { videoContainerJobId, type VideoContainerJobSpec } from "@breatic/shared/mini-tools";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { EXTENSION_OF_TYPE } from "@worker/handlers/extension-of-type.js";
import { audioOf, chunkInputId, FullLedgerInvalid, modelInputTarget, readJobLedger, SOURCE_INPUT_ID, windowDuration, windowEntries, windowInterval } from "@worker/handlers/video-presentation-recipes.js";

type Removal = Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>;
/** What a model-input preparation reads of its run: a removal's, or a lip-sync run's used source range (§97 D21). */
export type PreparingRun = Pick<Removal, "taskId" | "sourceKey" | "ledgerReceipts" | "presentationRef" | "preparation">;
type UpstreamStep = upstreamStepRepo.UpstreamStep;
/**
 * One preparation unit: its §5.4 id per attempt, its recipe, its consumption chunk index, and whether its output is the
 * prepared input the run keeps (with the chunk outputs that output consumed).
 */
interface Unit {
  spec: (attempt: number) => VideoContainerJobSpec;
  /** The recipe and the inputs it binds besides the source (a stitch's chunks). */
  recipe: () => { recipe: MiniToolPlanRecipe; inputs?: { inputId: string; storageKey: string }[] } | null;
  chunkIndex: number;
  final: boolean;
  consumed?: string[];
}

/**
 * A step's work object key: the source's work key for the job, ending in the extension of the type it holds.
 * @param sourceKey - The source's storage key.
 * @param jobId - The job of the attempt.
 * @param contentType - The type the job writes.
 * @returns The key.
 * @throws {Error} When the type has no extension here.
 */
export function stepWorkKey(sourceKey: string, jobId: string, contentType: string): string {
  const extension = EXTENSION_OF_TYPE[contentType];
  if (extension === undefined) throw new Error(`No file extension for ${contentType}`);
  return `${videoPresentationWorkKeyFor(sourceKey, jobId)}${extension}`;
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
export async function appendStep(taskId: string, planned: { kind: UpstreamStep["kind"]; endpoint: string; itemIndex: number | null }): Promise<UpstreamStep> {
  const existing = await upstreamStepRepo.listSteps(taskId);
  const position = existing.length;
  const rows = await upstreamStepRepo.ensureSteps(taskId, [...existing.map(({ kind, endpoint, itemIndex }) => ({ kind, endpoint, itemIndex })), planned]);
  const appended = rows.find((row) => row.position === position);
  if (appended === undefined) throw new Error("Appended step disappeared");
  return appended;
}

/**
 * The stored request of a container step, if any.
 * @param step - The step.
 * @returns The request.
 * @throws {never} Never.
 */
function storedRequest(step: UpstreamStep): MiniToolPlanJobRequest | null {
  const parsed = miniToolPlanJobRequestSchema.safeParse(step.output.miniToolPlanJob);
  return step.kind === "container_job" && parsed.success ? parsed.data : null;
}

/**
 * Advance one unit: the latest attempt's job, or the next attempt after a failure.
 * @param execution - The frozen removal.
 * @param unit - The unit.
 * @param deadlineAt - The task deadline.
 * @returns The done attempt's output key.
 * @throws {StillRunning} While the attempt runs.
 * @throws {UpstreamTaskFailed} When the last allowed attempt failed.
 * @throws {Error} When persistence or the job boundary fails.
 */
async function advanceUnit(execution: PreparingRun, unit: Unit, deadlineAt: number): Promise<string> {
  // The retry cap frozen at admission (§3.2 item 1), never today's configuration.
  const retries = execution.preparation.chunkRetries;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const jobId = videoContainerJobId(unit.spec(attempt));
    const steps = await upstreamStepRepo.listSteps(execution.taskId);
    const existing = steps.find((candidate) => storedRequest(candidate)?.jobId === jobId);
    const state = existing?.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(existing.output.miniToolStep);
    if (state?.result?.outcome === "failed") continue;
    if (existing !== undefined && state?.result?.outcome === "done") return storedRequest(existing)!.outputs[0]!.storageKey;
    const built = unit.recipe();
    if (built === null) throw new Error("The preparation recipe needs its chunk outputs");
    const { preparation } = execution;
    const candidate: MiniToolPlanJobRequest = {
      schemaVersion: 2, jobId, containerClass: preparation.containerClass, deadlineAt, limits: preparation.limits,
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }, ...built.inputs ?? []],
      outputs: [{ outputIndex: 0, storageKey: stepWorkKey(execution.sourceKey, jobId, "video/mp4"), contentType: "video/mp4", recipe: built.recipe }],
    };
    const step = existing ?? await appendStep(execution.taskId, { kind: "container_job", endpoint: preparation.containerClass, itemIndex: unit.chunkIndex });
    const { request, consumption } = await openMiniToolPlanJob({ taskId: execution.taskId, stepId: step.id, chunkIndex: unit.chunkIndex, chargeTo: "user", request: candidate });
    const report = readMiniToolPlanJobReport(request, await advanceMiniToolPlanJob(request));
    if (report.state !== "done" && report.state !== "failed") throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
    const output = request.outputs[0]!.storageKey;
    // The prepared input is pinned with its result; a failed attempt's output and consumed chunks are retired (§7.15).
    const presentation = report.state === "failed" ? { retire: [output] }
      : unit.final ? { prepared: { toolInputId: execution.presentationRef.source.toolInputId, preparedKey: output }, retire: unit.consumed ?? [] } : undefined;
    await recordMiniToolStepResult({ taskId: execution.taskId, stepId: step.id, identity: consumption.identity, outcome: report.state, result: report,
      ...(report.state === "failed" ? { error: { code: report.reason } } : {}), ...(presentation === undefined ? {} : { presentation }) },
    { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(request, value) });
    if (report.state === "done") return request.outputs[0]!.storageKey;
  }
  throw new UpstreamTaskFailed("container", "The model input could not be prepared");
}

/**
 * The stored request of a run's done prepared model input: the single job's, or the stitch's over chunks.
 * @param owner - The run that prepared it.
 * @param single - Whether the preparation is one job.
 * @returns The request, or null when none is done.
 * @throws {Error} When the step read fails.
 */
export async function preparedRequest(owner: string, single: boolean): Promise<MiniToolPlanJobRequest | null> {
  const final = new RegExp(`^${owner}:prep:0:${single ? "" : "stitch:"}a\\d+$`);
  for (const step of await upstreamStepRepo.listSteps(owner)) {
    const request = storedRequest(step);
    if (request === null || !final.test(request.jobId) || step.output.miniToolStep === undefined) continue;
    if (miniToolStepStateSchema.parse(step.output.miniToolStep).result?.outcome === "done") return request;
  }
  return null;
}

/**
 * Prepare a run's model input, or find the original run's prepared object for a failed-output retry.
 * @param execution - The frozen run.
 * @param deadlineAt - The task deadline.
 * @param owner - The run whose preparation is used: this run, or the original run of a retry.
 * @returns The prepared object's storage key.
 * @throws {StillRunning} While a preparation job runs.
 * @throws {UpstreamTaskFailed} When the preparation failed for good.
 * @throws {Error} When the original preparation is missing, or persistence or the job boundary fails.
 */
export async function prepareModelInput(execution: PreparingRun, deadlineAt: number, owner: string = execution.taskId): Promise<string> {
  const chunks = execution.preparation.chunks;
  const single = chunks.length === 1;
  const done = await preparedRequest(owner, single);
  if (done !== null) return done.outputs[0]!.storageKey;
  if (owner !== execution.taskId) throw new Error("The original run has no prepared model input");
  const taskId = execution.taskId;
  // The recipes come from the full ledger the run froze (§91 D3b-5), checked against its presentation plan.
  // The receipt is frozen for the run, so a ledger that fails it never recovers here: the run fails at once (§91 D3b-9; a
  // new run freezes the repaired ledger). A transport failure keeps the normal retry.
  const ledger = await readJobLedger(execution.ledgerReceipts.source, deadlineAt).catch((error: unknown) => {
    if (error instanceof FullLedgerInvalid) {
      logger.error({ err: error, ctx: { taskId: execution.taskId, toolInputId: execution.presentationRef.source.toolInputId } }, "mini_tool_prepare_ledger_invalid");
      throw new UpstreamTaskFailed("container", "source_ledger_invalid");
    }
    throw error;
  });
  const target = modelInputTarget(ledger, execution.preparation.encode);
  const timescale = ledger.plan.presentation.timescale;
  if (single) {
    const window = { start: chunks[0]!.start, end: chunks[0]!.end };
    return advanceUnit(execution, { spec: (attempt) => ({ kind: "prep", taskId, input: 0, attempt }), chunkIndex: 0, final: true,
      recipe: () => ({ recipe: { kind: "prepare_model_input", inputId: SOURCE_INPUT_ID, window, timescale, entries: windowEntries(ledger, window), target,
        audio: audioOf(ledger, windowInterval(ledger, window)) } }) }, deadlineAt);
  }
  const outputs: (string | null)[] = [];
  let waiting = false;
  for (const [chunk, window] of chunks.entries()) {
    try {
      outputs.push(await advanceUnit(execution, { spec: (attempt) => ({ kind: "prep-chunk", taskId, input: 0, chunk, attempt }), chunkIndex: chunk, final: false,
        recipe: () => ({ recipe: { kind: "chunk_encode", inputId: SOURCE_INPUT_ID, window: { start: window.start, end: window.end }, timescale,
          entries: windowEntries(ledger, window), target } }) }, deadlineAt));
    } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      waiting = true;
      outputs.push(null);
    }
  }
  if (waiting) throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
  return advanceUnit(execution, { spec: (attempt) => ({ kind: "prep-stitch", taskId, input: 0, attempt }), chunkIndex: chunks.length, final: true, consumed: outputs as string[],
    recipe: () => ({
      recipe: { kind: "stitch", inputId: SOURCE_INPUT_ID, chunks: chunks.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: windowDuration(ledger, window) })),
        audio: audioOf(ledger, windowInterval(ledger, { start: chunks[0]!.start, end: chunks[chunks.length - 1]!.end })), target },
      inputs: (outputs as string[]).map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey })),
    }) }, deadlineAt);
}
