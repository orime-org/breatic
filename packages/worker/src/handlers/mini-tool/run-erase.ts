// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The erase runner on the frozen plan (inner#1306 execution design §10.4), on the tool-independent step runner (§10.7). Each
 * pickup walks the steps in order and a done step answers again without being redone:
 * - prepare: the range's frames as the model input, timed on the frozen model grid;
 * - mask: the tracked RLE as the model's mask video on the same grid;
 * - generate: one Bria request on the two, its result fetched into a derived key;
 * - composite: the whole presentation in its frozen chunks, each range frame showing its grid slot's result through the
 *   dilated and feathered RLE mask;
 * - stitch: the chunks joined with the source's audio into the run's one registered output.
 * A step that fails for good ends the output with `{ kind: "erase", step, category }`.
 */
import { z } from "zod";
import { getStorageAdapter, logger } from "@breatic/core";
import type { AcceptedMiniToolExecution, MiniToolStepJson } from "@breatic/domain";
import type { EraseFailureReason } from "@breatic/shared/mini-tools";
import type { LipSyncPickup } from "@worker/handlers/mini-tool/run-lip-sync.js";
import {
  advanceChunks, advanceContainer, advanceGenerate, advanceRegistered, catalogModel, eraseContainerCategory, modelRunFailure, modelStepCategory, providerModel, runLedger, type ModelRunAt,
  type ModelRunPosition, type ModelStepRun,
} from "@worker/handlers/mini-tool/model-run-steps.js";
import { audioOf, chunkInputId, gridSlack, modelInputTarget, segmentTarget, SOURCE_INPUT_ID, windowDuration, windowEntries } from "@worker/handlers/video-presentation-recipes.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { upstreamBody } from "@worker/providers/upstream-body.js";

type Erase = Extract<AcceptedMiniToolExecution, { tool: "video.erase" }>;
type Step = EraseFailureReason["step"];

/** The input ids the recipes bind their objects under, fixed so a rebuilt request is the same request. */
const RLE = "00000000-0000-4000-8002-000000000000";
const RESULT = "00000000-0000-4000-8004-000000000000";
const outputs = z.tuple([z.url()]);

/**
 * A frozen step key.
 * @param plan - The frozen run.
 * @param step - The step.
 * @returns The key.
 * @throws {Error} When the plan froze none.
 */
function keyOf(plan: Erase, step: string): string {
  const key = plan.stepKeys[step];
  if (key === undefined) throw new Error(`The erase plan froze no key for ${step}`);
  return key;
}

/**
 * Run one pickup of an erase.
 * @param execution - The frozen run.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @param at - Where the walk stands, kept for the entry's reason when a step throws (§10.4).
 * @returns The output's result once it ended, and whether a step still runs.
 * @throws {Error} When persistence, grants, registration or IO fail.
 */
export async function runMiniToolErase(execution: unknown, userId: string, deadlineAt: number, at: ModelRunAt = { position: null }): Promise<LipSyncPickup> {
  const plan = execution as Erase;
  const pickup: LipSyncPickup = { results: new Map(), waiting: false };
  const run: ModelStepRun = { taskId: plan.taskId, projectId: plan.projectId, sourceKey: plan.sourceKey, container: plan.container,
    ...(plan.retry === undefined ? {} : { retry: { runId: plan.retry.runId } }), log: "erase" };
  const position: Extract<ModelRunPosition, { tool: "video.erase" }> = { tool: "video.erase", step: "prepare" };
  at.position = position;
  /**
   * End the output with its reason; a step whose next attempt was due after the deadline ends it as the run's expiry.
   * @param failedStep - The step that failed.
   * @param category - Why.
   * @param expired - Whether the step expired.
   * @returns The pickup.
   * @throws {never} Never.
   */
  const fail = (failedStep: Step, category: EraseFailureReason["category"], expired = false): LipSyncPickup => {
    pickup.results.set(0, { status: "failed", error: expired ? modelRunFailure("video.erase", position, true) : { kind: "erase", step: failedStep, category } });
    return pickup;
  };
  try {
    const ledger = await runLedger(run, plan.ledgerReceipts.source, deadlineAt);
    const table = ledger.plan.presentation;
    const target = modelInputTarget(ledger, plan.container.encode);
    const range = { startFrame: plan.range.start, frameCount: plan.range.end - plan.range.start };
    const prepared = await advanceContainer(run, { stepKey: keyOf(plan, "prepare"), contentType: "video/mp4", failed: (reason) => ({ failed: eraseContainerCategory(reason) }),
      build: () => Promise.resolve({ recipe: { kind: "prepare_model_input", inputId: SOURCE_INPUT_ID, window: plan.range, timescale: table.timescale,
        entries: windowEntries(ledger, plan.range), target, audio: null, grid: { ...plan.grid, slack: gridSlack(ledger) } }, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: plan.sourceKey }] }) }, deadlineAt);
    if (!("key" in prepared)) return fail("prepare", prepared.failed as EraseFailureReason["category"], prepared.expired);
    position.step = "mask";
    const mask = await advanceContainer(run, { stepKey: keyOf(plan, "mask"), contentType: "video/mp4", failed: (reason) => ({ failed: eraseContainerCategory(reason) }),
      build: () => Promise.resolve({ recipe: { kind: "bria_mask", inputId: RLE, table, range, grid: { ...plan.grid, slack: gridSlack(ledger) }, target: { width: target.width, height: target.height } },
        inputs: [{ inputId: RLE, storageKey: plan.tracking.rleKey }] }) }, deadlineAt);
    if (!("key" in mask)) return fail("mask", mask.failed as EraseFailureReason["category"], mask.expired);
    position.step = "generate";
    const storage = await getStorageAdapter();
    const result = await advanceGenerate(run, { endpoint: providerModel(plan.model), itemIndex: 0, stepKey: keyOf(plan, "generate"), contentType: "video/mp4",
      category: (error) => modelStepCategory(error, plan.asyncRejection),
      link: (answer) => { const parsed = outputs.safeParse(answer); return parsed.success ? parsed.data[0] : null; },
      body: () => Promise.resolve(upstreamBody(catalogModel(plan.model), { video: storage.publicUrl(prepared.key), mask_video: storage.publicUrl(mask.key), copy_audio: false }, "") as Record<string, MiniToolStepJson>) },
    userId, deadlineAt);
    if (!("key" in result)) return fail("generate", result.failed as EraseFailureReason["category"], result.expired);
    position.step = "composite";
    const output = segmentTarget(ledger, plan.container.encode);
    const chunks = await advanceChunks(run, plan.composite.map((window, k) => ({ stepKey: keyOf(plan, `composite:${k}`), contentType: "video/mp4",
      failed: (reason) => ({ failed: eraseContainerCategory(reason) }),
      build: () => Promise.resolve({ recipe: { kind: "model_composite", mode: "erase", inputId: SOURCE_INPUT_ID, window, timescale: table.timescale, entries: windowEntries(ledger, window),
        target: { ...output, format: undefined }, result: RESULT, rle: RLE, table, range, grid: { ...plan.grid, slack: gridSlack(ledger) }, matte: plan.matte, rleSize: { width: target.width, height: target.height } },
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: plan.sourceKey }, { inputId: RESULT, storageKey: result.key }, { inputId: RLE, storageKey: plan.tracking.rleKey }] }) })), deadlineAt);
    if (!("keys" in chunks)) return fail("composite", chunks.failed as EraseFailureReason["category"], chunks.expired);
    position.step = "stitch";
    const written = await advanceRegistered(run, { stepKey: keyOf(plan, "stitch"), namePrefix: "ERASE", container: output.format === "webm-vp9" ? "webm" : "mp4",
      build: () => Promise.resolve({ recipe: { kind: "stitch", inputId: SOURCE_INPUT_ID, target: output, audio: audioOf(ledger),
        chunks: plan.composite.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: windowDuration(ledger, window) })) },
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: plan.sourceKey }, ...chunks.keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey }))] }) }, userId, deadlineAt);
    if ("failed" in written) return fail("stitch", "failed", written.expired);
    pickup.results.set(0, written);
    return pickup;
  } catch (error) {
    if (error instanceof StillRunning) { pickup.waiting = true; return pickup; }
    // Only the ledger read and the preparation throw this here; a provider's failure is caught where it is called.
    if (error instanceof UpstreamTaskFailed) {
      logger.error({ err: error, ctx: { taskId: plan.taskId, step: position.step } }, "mini_tool_erase_step_failed");
      return fail(position.step, "failed");
    }
    throw error;
  }
}
