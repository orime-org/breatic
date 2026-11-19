// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extract-frames and split runners on the frozen plan (inner#1306 §93 D5-1..D5-11; frames-split design §5.4 user-run
 * encoding and job identities, §7.11 per-output results, §7.15, §7.17, §10.8).
 *
 * Each pickup reads the full ledger the run froze, writes every output's job recipe with the D4 builders and the frozen
 * encode, and advances the frozen layout as it is: each batch is a `run-batch` job registered through
 * `advanceRegisteredMiniToolPlanJob`, whose next attempt carries only the outputs not yet written, up to the frozen
 * `chunkRetries`; an oversized segment runs its frozen chunk windows as `run-chunk` work objects (the model-input
 * preparation path) and one registered `run-stitch` that retires them. The caller commits what each pickup finished.
 */

import { logger } from "@breatic/core";
import { assetRepo, openContainerOutputs, type AcceptedMiniToolExecution } from "@breatic/domain";
import { DeadlinePassed, miniToolPlanJobRequestSchema, videoPresentationWorkKeyFor, type MiniToolPlanRecipe, type StudioAssetEntity, type VideoPresentationLedger } from "@breatic/shared";
import { miniToolExecutionOutputSchema, videoContainerJobId, type MiniToolExecutionOutput } from "@breatic/shared/mini-tools";
import { advanceChunks, advanceRegistered, jobStep } from "@worker/handlers/mini-tool/model-run-steps.js";
import { advanceRegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { chunkInputId, frameRecipeOf, FullLedgerInvalid, rangeWindow, readJobLedger, segmentRecipesOf, SOURCE_INPUT_ID } from "@worker/handlers/video-presentation-recipes.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/handlers/still-running.js";

/** A frames or split execution. */
type VideoTool = Extract<AcceptedMiniToolExecution, { tool: "video.extract-frames" | "video.split" }>;
/** One output's result: registered, failed, or null while it still runs. */
export type VideoToolResult = MiniToolExecutionOutput["result"];
/** What one pickup observed of every output, by output index. */
export interface VideoToolPickup { results: Map<number, NonNullable<VideoToolResult>>; waiting: boolean }
/** The tool's PNG or video output and its recipe. */
interface PlannedOutput { outputIndex: number; recipe: MiniToolPlanRecipe }

/** An output result's schema. */
const miniToolExecutionResultSchema = miniToolExecutionOutputSchema.shape.result.unwrap();

/**
 * A registered output's public result: the canonical row and its cover.
 * @param asset - The registered row.
 * @returns The result.
 * @throws {Error} When the cover read fails.
 */
export async function registered(asset: StudioAssetEntity): Promise<NonNullable<VideoToolResult>> {
  const cover = await assetRepo.findCoverOf(asset.id);
  return miniToolExecutionResultSchema.parse({ status: "registered", assetId: asset.id, canonicalURL: asset.fileUrl, kind: asset.kind, contentHash: asset.contentHash,
    mimeType: asset.mimeType, size: asset.sizeBytes, width: asset.width, height: asset.height, duration: asset.durationSeconds,
    cover: cover === null ? null : { assetId: cover.id, canonicalURL: cover.fileUrl, kind: cover.kind, contentHash: cover.contentHash,
      mimeType: cover.mimeType, size: cover.sizeBytes, width: cover.width, height: cover.height } });
}

/**
 * A failed output's result.
 * @param reason - Why.
 * @returns The result.
 * @throws {never} Never.
 */
export function failedResult(reason: string): NonNullable<VideoToolResult> {
  // A step that ended at the run's deadline expired, as the run itself does (run-execution-task's DeadlinePassed failure).
  if (reason === "expired") return { status: "failed", error: { code: "expired" } };
  return { status: "failed", error: { code: "mini_tool_failed", message: reason } };
}

/**
 * Whether a recipe writes a VP9 WebM: a transparent source's split output (§7.17 segment row, §93 D5-12).
 * @param recipe - The recipe.
 * @returns Whether its target is WebM.
 * @throws {never} Never.
 */
function webm(recipe: MiniToolPlanRecipe): boolean {
  return "target" in recipe && "format" in recipe.target && recipe.target.format === "webm-vp9";
}

/**
 * The grant a planned output is written to: a PNG for a frame, an MP4 or, for a transparent split output, a WebM video.
 * @param recipe - The output's recipe.
 * @returns The grant's output declaration.
 * @throws {never} Never.
 */
function grantOf(recipe: MiniToolPlanRecipe): { modality: "image" | "video"; namePrefix: string; container?: "webm" } {
  if (recipe.kind === "frame") return { modality: "image", namePrefix: "FRAME" };
  return { modality: "video", namePrefix: "SPLIT", ...(webm(recipe) ? { container: "webm" as const } : {}) };
}

/**
 * The job recipe of a planned output (§7.17, the worker's recipe construction): a frame's entry and PNG target, or a segment over its range's
 * frames with the frozen encode.
 * @param execution - The run.
 * @param ledger - The frozen full ledger.
 * @param outputIndex - The output.
 * @returns The planned output.
 * @throws {RangeError} When the selection is not on presented frames.
 */
function plannedOutput(execution: VideoTool, ledger: VideoPresentationLedger, outputIndex: number): PlannedOutput {
  const recipe = execution.outputs[outputIndex]!.recipe;
  if (recipe.kind === "frame") return { outputIndex, recipe: frameRecipeOf(ledger, { frameIndex: recipe.frameIndex, pts: recipe.pts }, SOURCE_INPUT_ID) };
  if (recipe.kind !== "segment") throw new Error("A frames or split run plans only frames and segments");
  const window = rangeWindow(ledger, recipe.range);
  return { outputIndex, recipe: segmentRecipesOf(ledger, { range: recipe.range }, SOURCE_INPUT_ID, execution.container.encode, [window])[0]! };
}

/**
 * Advance one frozen batch (§93 D5-3): each attempt carries only the outputs earlier attempts did not write; outputs still
 * unwritten when the frozen retries are spent fail alone.
 * @param execution - The run.
 * @param ledger - The frozen full ledger.
 * @param batch - The batch index.
 * @param outputs - Its output indices.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @param pickup - The pickup's results, extended in place.
 * @returns Nothing once the batch is settled or still running.
 * @throws {Error} When persistence, grants or registration fail.
 */
async function advanceBatch(execution: VideoTool, ledger: VideoPresentationLedger, batch: number, outputs: readonly number[], userId: string, deadlineAt: number,
  pickup: VideoToolPickup): Promise<void> {
  for (let attempt = 1; attempt <= execution.container.chunkRetries + 1; attempt += 1) {
    const pending = outputs.filter((index) => !pickup.results.has(index));
    if (pending.length === 0) return;
    const jobId = videoContainerJobId({ kind: "run-batch", taskId: execution.taskId, batch, attempt });
    const found = await jobStep(execution.taskId, jobId, execution.container.containerClass, deadlineAt);
    // An attempt due after the deadline is never opened: the outputs it would carry expire, the other batches settle.
    if (found === null) {
      for (const index of pending) pickup.results.set(index, failedResult("expired"));
      return;
    }
    const { step, request: stored } = found;
    let request = stored;
    if (request === null) {
      const planned = pending.map((index) => plannedOutput(execution, ledger, index));
      const grants = await openContainerOutputs({ projectId: execution.projectId, actingUserId: userId, taskId: execution.taskId, deadlineAt,
        outputs: planned.map((output) => grantOf(output.recipe)) });
      if (grants.length !== planned.length) throw new Error("Tool outputs require their complete upload grants");
      request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId, containerClass: execution.container.containerClass, deadlineAt, limits: execution.container.limits,
        inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }],
        outputs: planned.map((output, index) => ({ ...grants[index], outputIndex: output.outputIndex, recipe: output.recipe })) });
    }
    let job: Awaited<ReturnType<typeof advanceRegisteredMiniToolPlanJob>>;
    try {
      job = await advanceRegisteredMiniToolPlanJob({ taskId: execution.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: "user", request });
    } catch (error) {
      // A job that can no longer be submitted or waited for expires its unwritten outputs; the other batches are still read.
      if (error instanceof DeadlinePassed) {
        for (const index of pending) pickup.results.set(index, failedResult("expired"));
        return;
      }
      if (!(error instanceof StillRunning)) throw error;
      pickup.waiting = true;
      return;
    }
    for (const entry of job.assets) pickup.results.set(entry.outputIndex, await registered(entry.asset));
    if (job.report.state === "done") continue;
    // An attempt ingest ended at the deadline has no next one: its unwritten outputs expire.
    if (attempt === execution.container.chunkRetries + 1 || job.report.reason === "expired") {
      for (const index of outputs) if (!pickup.results.has(index)) pickup.results.set(index, failedResult(job.report.reason));
      return;
    }
  }
}

/**
 * Advance an oversized segment (§93 D5-10; design §5.4): its frozen chunk windows, then one registered stitch over them
 * that retires the consumed chunk keys; a chunk whose retries are spent fails only this segment.
 * @param execution - The run.
 * @param ledger - The frozen full ledger.
 * @param encode - The frozen encode plan of the output.
 * @param encode.outputIndex - The output.
 * @param encode.chunks - Its frozen chunk windows.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @param pickup - The pickup's results, extended in place.
 * @returns Nothing once the segment is settled or still running.
 * @throws {Error} When persistence, grants or registration fail.
 */
async function advanceEncode(execution: VideoTool, ledger: VideoPresentationLedger, encode: VideoTool["layout"]["encodes"][number], userId: string, deadlineAt: number,
  pickup: VideoToolPickup): Promise<void> {
  const { outputIndex } = encode;
  const recipe = execution.outputs[outputIndex]!.recipe;
  if (recipe.kind !== "segment") throw new Error("Only a segment is encoded in chunks");
  const recipes = segmentRecipesOf(ledger, { range: recipe.range }, SOURCE_INPUT_ID, execution.container.encode, encode.chunks);
  // Each chunk is a work object on the model-input preparation path (§93 D5-10), never registered: a done output is pinned
  // with the run, a failed attempt's output retired with its result, the next attempt run under its own id.
  let chunks: Awaited<ReturnType<typeof advanceChunks>>;
  try {
    chunks = await advanceChunks({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "split" },
      encode.chunks.map((_window, chunk) => ({ contentType: webm(recipes[chunk]!) ? "video/webm" : "video/mp4",
        jobId: (attempt) => videoContainerJobId({ kind: "run-chunk", taskId: execution.taskId, output: outputIndex, chunk, attempt }),
        outputKey: (jobId) => videoPresentationWorkKeyFor(execution.sourceKey, jobId), failed: (reason) => ({ failed: reason }),
        build: () => Promise.resolve({ recipe: recipes[chunk]!, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }] }) })), deadlineAt);
  } catch (error) {
    if (!(error instanceof StillRunning)) throw error;
    pickup.waiting = true;
    return;
  }
  if (!("keys" in chunks)) { pickup.results.set(outputIndex, failedResult(chunks.failed)); return; }
  const { keys } = chunks;
  const stitch = recipes.at(-1)!;
  let written: Awaited<ReturnType<typeof advanceRegistered>>;
  try {
    written = await advanceRegistered({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "split" },
      { stepKey: `out:${outputIndex}:stitch`, namePrefix: grantOf(stitch).namePrefix, container: webm(stitch) ? "webm" : "mp4", outputIndex, retire: keys,
        build: () => Promise.resolve({ recipe: stitch, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }, ...keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey }))] }) },
      userId, deadlineAt);
  } catch (error) {
    if (!(error instanceof StillRunning)) throw error;
    pickup.waiting = true;
    return;
  }
  pickup.results.set(outputIndex, "failed" in written ? failedResult(written.failed) : written);
}

/**
 * One pickup of a frames or split run (§93 D5-1..D5-10): read the frozen full ledger and advance every frozen batch and
 * oversized segment, batches in parallel within the pickup (§5.4).
 * @param execution - The frozen run.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @param pickup - The pickup's results, filled in place as outputs settle, so a caller still holds the outputs registered
 * before a throw.
 * @returns Every output settled so far, and whether any job still runs.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when the frozen ledger fails its receipt.
 * @throws {Error} When the ledger read fails in transport, or persistence, grants or registration fail.
 */
export async function runMiniToolVideoTool(execution: AcceptedMiniToolExecution, userId: string, deadlineAt: number,
  pickup: VideoToolPickup = { results: new Map(), waiting: false }): Promise<VideoToolPickup> {
  if (execution.tool !== "video.extract-frames" && execution.tool !== "video.split") throw new Error("A frames or split runner requires a frames or split run");
  let ledger: VideoPresentationLedger;
  try {
    ledger = await readJobLedger(execution.ledgerReceipts.source, planReadUntil(deadlineAt));
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    // The receipt is frozen for the run, so a ledger that fails it never recovers here (§91 D3b-9, D4-7).
    logger.error({ err: error, ctx: { taskId: execution.taskId, toolInputId: execution.presentationRef.source.toolInputId } }, "mini_tool_video_tool_ledger_invalid");
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
  for (const [batch, outputs] of execution.layout.batches.entries()) await advanceBatch(execution, ledger, batch, outputs, userId, deadlineAt, pickup);
  for (const encode of execution.layout.encodes) await advanceEncode(execution, ledger, encode, userId, deadlineAt, pickup);
  return pickup;
}
