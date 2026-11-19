// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The model-input preparation of a planned removal (inner#1306; frames-split design §5.3 model-input row, §5.4 job identities,
 * §7.1.1): before `generate`, the frozen preparation runs as standard-4 `container_job` steps — one `prepare_model_input`
 * job over the whole presentation window, or `chunk_encode` jobs plus a `stitch` — each attempt under its §5.4 id, its
 * output key from the shared key function and its expense opened with the step, on the model runs' step runner
 * (`model-run-steps.ts`). A failed attempt is retried under the next attempt's id up to the frozen chunk retries; the
 * chunks advance as one chunk list, each done chunk pinned with the run. A failed-output retry reuses the original run's
 * prepared object.
 */

import { logger } from "@breatic/core";
import { miniToolStepStateSchema, upstreamStepRepo, type AcceptedMiniToolExecution } from "@breatic/domain";
import { DeadlinePassed, videoPresentationWorkKeyFor, type MiniToolPlanJobRequest, type MiniToolPlanRecipe } from "@breatic/shared";
import { videoContainerJobId, type VideoContainerJobSpec } from "@breatic/shared/mini-tools";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { advanceChunks, advanceContainer, storedRequest, type ContainerStep, type ModelStepRun } from "@worker/handlers/mini-tool/model-run-steps.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { EXTENSION_OF_TYPE } from "@worker/handlers/extension-of-type.js";
import { audioOf, chunkInputId, FullLedgerInvalid, modelInputTarget, readJobLedger, SOURCE_INPUT_ID, windowDuration, windowEntries, windowInterval } from "@worker/handlers/video-presentation-recipes.js";

type Removal = Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>;
/** What a model-input preparation reads of its run: a removal's, or a lip-sync run's used source range (§97 D21). */
export type PreparingRun = Pick<Removal, "taskId" | "projectId" | "sourceKey" | "ledgerReceipts" | "presentationRef" | "preparation">;
type UpstreamStep = upstreamStepRepo.UpstreamStep;
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

/** Why a preparation that failed for good fails its run. */
const PREPARATION_FAILED = "The model input could not be prepared";

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
 * @throws {DeadlinePassed} When a preparation job's next attempt is due after the deadline.
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
  // Reading it starts no new work, so a pickup after the deadline still reads the jobs submitted before it (`planReadUntil`).
  const ledger = await readJobLedger(execution.ledgerReceipts.source, planReadUntil(deadlineAt)).catch((error: unknown) => {
    if (error instanceof FullLedgerInvalid) {
      logger.error({ err: error, ctx: { taskId: execution.taskId, toolInputId: execution.presentationRef.source.toolInputId } }, "mini_tool_prepare_ledger_invalid");
      throw new UpstreamTaskFailed("container", "source_ledger_invalid");
    }
    throw error;
  });
  const target = modelInputTarget(ledger, execution.preparation.encode);
  const timescale = ledger.plan.presentation.timescale;
  // The retry cap frozen at admission (§3.2 item 1), never today's configuration.
  const { preparation } = execution;
  const run: ModelStepRun = { taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, log: "prepare",
    container: { containerClass: preparation.containerClass, limits: preparation.limits, chunkRetries: preparation.chunkRetries } };
  /**
   * One preparation unit on the source: its §5.4 id per attempt, its consumption chunk index and its recipe.
   * @param spec - Its §5.4 id per attempt.
   * @param chunkIndex - Its consumption chunk index.
   * @param recipe - Its recipe.
   * @param bound - The inputs it binds besides the source (a stitch's chunks).
   * @returns The step.
   * @throws {never} Never.
   */
  const unit = (spec: (attempt: number) => VideoContainerJobSpec, chunkIndex: number, recipe: MiniToolPlanRecipe, bound: { inputId: string; storageKey: string }[] = []): ContainerStep => ({
    contentType: "video/mp4", jobId: (attempt) => videoContainerJobId(spec(attempt)), chunkIndex,
    failed: () => ({ failed: PREPARATION_FAILED }), build: () => Promise.resolve({ recipe, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }, ...bound] }) });
  /**
   * The pins of the done prepared input: the run keeps it, and the chunks it consumed are retired (§7.15).
   * @param consumed - The chunk outputs it consumed.
   * @returns The pins.
   * @throws {never} Never.
   */
  const final = (consumed: string[]): ContainerStep["done"] => (output) => ({ prepared: { toolInputId: execution.presentationRef.source.toolInputId, preparedKey: output }, retire: consumed });
  /**
   * The prepared input's key once its unit is done.
   * @param planned - The final unit.
   * @returns The key.
   * @throws {UpstreamTaskFailed} When the unit failed for good.
   * @throws {DeadlinePassed} When its next attempt is due after the deadline.
   */
  const prepared = async (planned: ContainerStep): Promise<string> => {
    const ended = await advanceContainer(run, planned, deadlineAt);
    if (!("key" in ended)) throw ended.expired === true ? new DeadlinePassed() : new UpstreamTaskFailed("container", PREPARATION_FAILED);
    return ended.key;
  };
  if (single) {
    const window = { start: chunks[0]!.start, end: chunks[0]!.end };
    return prepared({ ...unit((attempt) => ({ kind: "prep", taskId, input: 0, attempt }), 0, { kind: "prepare_model_input", inputId: SOURCE_INPUT_ID, window, timescale,
      entries: windowEntries(ledger, window), target, audio: audioOf(ledger, windowInterval(ledger, window)) }), done: final([]) });
  }
  // Every chunk advances in each pickup and the preparation settles once none still runs, each done chunk pinned with the run.
  const outputs = await advanceChunks(run, chunks.map((window, chunk) => unit((attempt) => ({ kind: "prep-chunk", taskId, input: 0, chunk, attempt }), chunk,
    { kind: "chunk_encode", inputId: SOURCE_INPUT_ID, window: { start: window.start, end: window.end }, timescale, entries: windowEntries(ledger, window), target })), deadlineAt);
  if (!("keys" in outputs)) throw outputs.expired === true ? new DeadlinePassed() : new UpstreamTaskFailed("container", PREPARATION_FAILED);
  return prepared({ ...unit((attempt) => ({ kind: "prep-stitch", taskId, input: 0, attempt }), chunks.length, { kind: "stitch", inputId: SOURCE_INPUT_ID,
    chunks: chunks.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: windowDuration(ledger, window) })),
    audio: audioOf(ledger, windowInterval(ledger, { start: chunks[0]!.start, end: chunks[chunks.length - 1]!.end })), target },
  outputs.keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey }))), done: final(outputs.keys) });
}
