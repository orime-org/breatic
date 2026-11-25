// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extract-frames, split and video focus crop runners on the frozen plan (inner#1306 §93 D5-1..D5-11; frames-split design §5.4 user-run
 * encoding and job identities, §7.15, §7.17, §7.19, §10.8).
 *
 * Each pickup writes every output's job recipe on the frozen version's grid and tool source (§7.16) with the frozen
 * encode, and advances the frozen layout as it is: each batch is a `run-batch` job staged through
 * `advanceStagedMiniToolPlanJob`, whose next attempt carries only the outputs not yet written, up to the frozen
 * `chunkRetries`; an oversized segment runs its frozen chunk windows as `run-chunk` work objects
 * (`container-steps.ts`) and one staged `run-stitch` that retires them. A run is one whole (§7.19): nothing is registered
 * while it runs, the first output that fails for good ends the pickup's work, and `registerReportedOutputs` registers
 * every staged output once the caller has written the run's commit point.
 */

import { assetRepo, miniToolStepStateSchema, openContainerOutputs, upstreamStepRepo, type AcceptedMiniToolExecution } from "@breatic/domain";
import { DeadlinePassed, miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, videoPresentationWorkKeyFor, writesWorkObject, type MiniToolPlanRecipe,
  type StudioAssetEntity } from "@breatic/shared";
import { miniToolExecutionOutputSchema, videoContainerJobId, type MiniToolExecutionOutput } from "@breatic/shared/mini-tools";
import { advanceChunks, advanceStaged, jobStep, storedRequest } from "@worker/handlers/mini-tool/container-steps.js";
import { advanceStagedMiniToolPlanJob, registerMiniToolPlanJobOutputs, type StagedMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { chunkInputId, frameRecipeOf, segmentRecipesOf, toolInputOf, type ToolInput } from "@worker/handlers/video-presentation-recipes.js";
import { StillRunning } from "@worker/handlers/still-running.js";

/** A frames, split or video focus crop execution. */
type VideoTool = Extract<AcceptedMiniToolExecution, { tool: "video.extract-frames" | "video.split" | "video.focus-crop" }>;
/** One output's result: registered, failed, or null while it still runs. */
export type VideoToolResult = MiniToolExecutionOutput["result"];
/** A failed output's result. */
type FailedResult = Extract<NonNullable<VideoToolResult>, { status: "failed" }>;
/** What one pickup observed of an output: its report staged, or its final failure. */
export type VideoToolOutcome = { status: "reported" } | FailedResult;
/** What one pickup observed of every output, by output index, in the order it observed them. */
export interface VideoToolPickup { results: Map<number, VideoToolOutcome>; waiting: boolean }
/** The tool's PNG or video output, its recipe and the inputs it reads. */
interface PlannedOutput { outputIndex: number; recipe: MiniToolPlanRecipe; inputs: ToolInput["inputs"] }

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
export function failedResult(reason: string): FailedResult {
  // A step that ended at the run's deadline expired, as the run itself does (run-execution-task's DeadlinePassed failure).
  if (reason === "expired") return { status: "failed", error: { code: "expired" } };
  return { status: "failed", error: { code: "mini_tool_failed", message: reason } };
}

/**
 * The first output of the pickup that failed for good: from then on nothing new opens (frames-split §7.19).
 * @param pickup - The pickup.
 * @returns Its failure, or undefined while none failed.
 * @throws {never} Never.
 */
export function firstFailure(pickup: VideoToolPickup): FailedResult | undefined {
  return [...pickup.results.values()].find((result): result is FailedResult => result.status === "failed");
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
  if (recipe.kind === "frame") return { modality: "image", namePrefix: recipe.crop === undefined ? "FRAME" : "FOCUS" };
  return { modality: "video", namePrefix: "SPLIT", ...(webm(recipe) ? { container: "webm" as const } : {}) };
}

/**
 * An output's recipe by its output index.
 * @param execution - The run.
 * @param outputIndex - The output.
 * @returns Its recipe.
 * @throws {Error} When the run plans no such output.
 */
function recipeOf(execution: VideoTool, outputIndex: number): VideoTool["outputs"][number]["recipe"] {
  const output = execution.outputs.find((item) => item.outputIndex === outputIndex);
  if (output === undefined) throw new Error("A layout names an output the run does not plan");
  return output.recipe;
}

/**
 * The job recipe of a planned output (§7.16, §7.17): a grid frame's PNG, cropped for a video focus crop (§5.5), or a segment
 * over its grid frames with the frozen encode, read from the frozen version's tool source.
 * @param execution - The run.
 * @param outputIndex - The output.
 * @returns The planned output.
 * @throws {Error} When the run plans another recipe.
 * @throws {MiniToolStepFailed} When the frozen version cannot build the recipe.
 */
function plannedOutput(execution: VideoTool, outputIndex: number): PlannedOutput {
  const recipe = recipeOf(execution, outputIndex);
  const version = execution.presentations.source;
  if (recipe.kind === "frame") return { outputIndex, ...frameRecipeOf(version, toolInputOf(version, execution.sourceKey), recipe.frameIndex, recipe.crop) };
  if (recipe.kind !== "segment") throw new Error("A frames or split run plans only frames and segments");
  const planned = segmentRecipesOf(version, execution.sourceKey, recipe.range, execution.container.encode, [recipe.range]);
  return { outputIndex, recipe: planned.recipes[0]!, inputs: planned.inputs };
}

/**
 * Advance one frozen batch (§93 D5-3): each attempt carries only the outputs earlier attempts did not write, and each
 * written output's report is staged; outputs still unwritten when the frozen retries are spent fail, and so does the run.
 * @param execution - The run.
 * @param batch - The batch index.
 * @param outputs - Its output indices.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @param pickup - The pickup's results, extended in place.
 * @param open - Whether its next attempt may be opened.
 * @returns True when its next attempt waits to be opened; false once the batch is settled, still running or stopped by a
 * failure.
 * @throws {Error} When persistence or grants fail.
 */
async function advanceBatch(execution: VideoTool, batch: number, outputs: readonly number[], userId: string, deadlineAt: number,
  pickup: VideoToolPickup, open: boolean): Promise<boolean> {
  for (let attempt = 1; attempt <= execution.container.chunkRetries + 1; attempt += 1) {
    const pending = outputs.filter((index) => !pickup.results.has(index));
    if (pending.length === 0 || firstFailure(pickup) !== undefined) return false;
    const jobId = videoContainerJobId({ kind: "run-batch", taskId: execution.taskId, batch, attempt });
    const found = await jobStep(execution.taskId, jobId, execution.container.containerClass, deadlineAt, open);
    if (found === "unopened") return true;
    // An attempt due after the deadline is never opened: the outputs it would carry expire.
    if (found === null) {
      for (const index of pending) pickup.results.set(index, failedResult("expired"));
      return false;
    }
    const { step, request: stored } = found;
    let request = stored;
    if (request === null) {
      const planned = pending.map((index) => plannedOutput(execution, index));
      const grants = await openContainerOutputs({ projectId: execution.projectId, actingUserId: userId, taskId: execution.taskId, deadlineAt,
        outputs: planned.map((output) => grantOf(output.recipe)) });
      if (grants.length !== planned.length) throw new Error("Tool outputs require their complete upload grants");
      request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId, containerClass: execution.container.containerClass, deadlineAt, limits: execution.container.limits,
        inputs: [...new Map(planned.flatMap((output) => output.inputs).map((input) => [input.inputId, input])).values()],
        outputs: planned.map((output, index) => ({ ...grants[index], outputIndex: output.outputIndex, recipe: output.recipe })) });
    }
    let job: StagedMiniToolPlanJob;
    try {
      // Who pays is the payer admission froze (frames-split §5.5): the platform for frame extraction and focus crops.
      job = await advanceStagedMiniToolPlanJob({ taskId: execution.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: execution.chargeTo, request });
    } catch (error) {
      // A job that can no longer be submitted or waited for expires its unwritten outputs.
      if (error instanceof DeadlinePassed) {
        for (const index of pending) pickup.results.set(index, failedResult("expired"));
        return false;
      }
      if (!(error instanceof StillRunning)) throw error;
      pickup.waiting = true;
      return false;
    }
    // A written output refused for its size is the run's final failure, never retried.
    if (job.refused !== null) {
      for (const index of pending) pickup.results.set(index, failedResult(job.refused));
      return false;
    }
    for (const output of job.report.outputs) if (pending.includes(output.outputIndex)) pickup.results.set(output.outputIndex, { status: "reported" });
    if (job.report.state === "done") continue;
    // An attempt ingest ended at the deadline has no next one: its unwritten outputs expire.
    if (attempt === execution.container.chunkRetries + 1 || job.report.reason === "expired") {
      for (const index of outputs) if (!pickup.results.has(index)) pickup.results.set(index, failedResult(job.report.reason));
      return false;
    }
  }
  return false;
}

/**
 * Advance an oversized segment (§93 D5-10; design §5.4): its frozen chunk windows, then one staged stitch over them that
 * retires the consumed chunk keys; a chunk whose retries are spent fails the segment, and so the run.
 * @param execution - The run.
 * @param encode - The frozen encode plan of the output.
 * @param encode.outputIndex - The output.
 * @param encode.chunks - Its frozen chunk windows.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @param pickup - The pickup's results, extended in place.
 * @param open - Whether a chunk's next attempt or the stitch may be opened.
 * @returns True when a chunk's next attempt or the stitch waits to be opened; false once the segment is settled or still
 * running.
 * @throws {Error} When persistence, grants or registration fail.
 */
async function advanceEncode(execution: VideoTool, encode: VideoTool["layout"]["encodes"][number], userId: string, deadlineAt: number,
  pickup: VideoToolPickup, open: boolean): Promise<boolean> {
  const { outputIndex } = encode;
  const recipe = recipeOf(execution, outputIndex);
  if (recipe.kind !== "segment") throw new Error("Only a segment is encoded in chunks");
  const { recipes, inputs } = segmentRecipesOf(execution.presentations.source, execution.sourceKey, recipe.range, execution.container.encode, encode.chunks);
  // Each chunk is a work object (container-steps.ts, §93 D5-10), never registered: a done output is pinned
  // with the run, a failed attempt's output retired with its result, the next attempt run under its own id.
  let chunks: Awaited<ReturnType<typeof advanceChunks>>;
  try {
    chunks = await advanceChunks({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "split" },
      encode.chunks.map((_window, chunk) => ({ contentType: webm(recipes[chunk]!) ? "video/webm" : "video/mp4",
        jobId: (attempt) => videoContainerJobId({ kind: "run-chunk", taskId: execution.taskId, output: outputIndex, chunk, attempt }),
        outputKey: (jobId) => videoPresentationWorkKeyFor(execution.sourceKey, jobId), failed: (reason) => ({ failed: reason }),
        build: () => Promise.resolve({ recipe: recipes[chunk]!, inputs: inputs.slice(0, 1) }) })), deadlineAt, open);
  } catch (error) {
    if (!(error instanceof StillRunning)) throw error;
    pickup.waiting = true;
    return false;
  }
  if ("unopened" in chunks) return true;
  if (!("keys" in chunks)) { pickup.results.set(outputIndex, failedResult(chunks.failed)); return false; }
  const { keys } = chunks;
  const stitch = recipes.at(-1) as Extract<MiniToolPlanRecipe, { kind: "stitch"; inputId: string }>;
  let written: Awaited<ReturnType<typeof advanceStaged>>;
  try {
    written = await advanceStaged({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "split" },
      { stepKey: `out:${outputIndex}:stitch`, namePrefix: grantOf(stitch).namePrefix, container: webm(stitch) ? "webm" : "mp4", outputIndex, retire: keys,
        build: () => Promise.resolve({ recipe: stitch, inputs: [...inputs.filter((input) => input.inputId === stitch.inputId), ...keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey }))] }) },
      userId, deadlineAt, open);
  } catch (error) {
    if (!(error instanceof StillRunning)) throw error;
    pickup.waiting = true;
    return false;
  }
  if ("unopened" in written) return true;
  pickup.results.set(outputIndex, "failed" in written ? failedResult(written.failed) : { status: "reported" });
  return false;
}

/**
 * One pickup of a frames, split or video focus crop run (§93 D5-1..D5-10): advance every frozen batch and oversized segment
 * on the frozen version's grid and tool source, stopping at the first output that fails for good (§7.19). Every attempt
 * already opened is read before any is opened, so a failure anywhere in the run is known before new work starts.
 * @param execution - The frozen run.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @returns Every output settled so far, and whether any job still runs.
 * @throws {Error} When persistence or grants fail.
 */
export async function runMiniToolVideoTool(execution: AcceptedMiniToolExecution, userId: string, deadlineAt: number): Promise<VideoToolPickup> {
  const tool = videoTool(execution);
  const pickup: VideoToolPickup = { results: new Map(), waiting: false };
  const steps = [
    ...tool.layout.batches.map((outputs, batch) => (open: boolean) => advanceBatch(tool, batch, outputs, userId, deadlineAt, pickup, open)),
    ...tool.layout.encodes.map((encode) => (open: boolean) => advanceEncode(tool, encode, userId, deadlineAt, pickup, open)),
  ];
  const unopened: typeof steps = [];
  for (const step of steps) {
    if (firstFailure(pickup) !== undefined) return pickup;
    if (await step(false)) unopened.push(step);
  }
  for (const step of unopened) {
    if (firstFailure(pickup) !== undefined) return pickup;
    await step(true);
  }
  return pickup;
}

/**
 * A frames, split or video focus crop run.
 * @param execution - The frozen run.
 * @returns It.
 * @throws {Error} When the run is of another tool.
 */
function videoTool(execution: AcceptedMiniToolExecution): VideoTool {
  if (execution.tool !== "video.extract-frames" && execution.tool !== "video.split" && execution.tool !== "video.focus-crop") throw new Error("A frames or split runner requires a frames or split run");
  return execution;
}

/**
 * Register every output a run staged, once the run's commit point is written (frames-split §7.19): each
 * output from the latest batch or stitch step whose report wrote it, a video output with a presentation deadline counted
 * from this registration. Registering again reads the step's cached registrations back.
 * @param execution - The frozen run.
 * @param deadlineAt - The presentation deadline of a video output.
 * @returns Each output's registered result, by output index.
 * @throws {Error} When an output has no staged step, or a registration is refused or unavailable.
 */
export async function registerReportedOutputs(execution: AcceptedMiniToolExecution, deadlineAt: number): Promise<Map<number, NonNullable<VideoToolResult>>> {
  const tool = videoTool(execution);
  const staged = new Map<number, string>();
  for (const step of [...await upstreamStepRepo.listSteps(tool.taskId)].sort((a, b) => a.position - b.position)) {
    const request = storedRequest(step);
    // A chunk's work object is never an output (§93 D5-10).
    if (request === null || step.output.miniToolStep === undefined || writesWorkObject(request, tool.sourceKey)) continue;
    const result = miniToolStepStateSchema.parse(step.output.miniToolStep).result;
    const report = result === null ? null : readMiniToolPlanJobReport(request, result.result);
    if (report?.state !== "done" && report?.state !== "failed") continue;
    for (const output of report.outputs) staged.set(output.outputIndex, step.id);
  }
  const results = new Map<number, NonNullable<VideoToolResult>>();
  for (const stepId of new Set(tool.outputs.map((output) => staged.get(output.outputIndex)))) {
    if (stepId === undefined) throw new Error("A reported output has no staged step");
    const wanted = tool.outputs.filter((output) => staged.get(output.outputIndex) === stepId).map((output) => output.outputIndex);
    for (const entry of await registerMiniToolPlanJobOutputs({ taskId: tool.taskId, stepId }, { deadlineAt })) {
      if (wanted.includes(entry.outputIndex)) results.set(entry.outputIndex, await registered(entry.asset));
    }
  }
  return results;
}
