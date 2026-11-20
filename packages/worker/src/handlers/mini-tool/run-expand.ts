// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The expand runner on the frozen plan (inner#1306 execution design §10.5), on the tool-independent step runner (§10.7). The
 * windows run in order; each pickup resumes where the run is and a done step answers again without being redone:
 * - window:k, window_mask:k: the window's model input (each grid slot's covering frame in `sourceRoi` of the standard frame
 *   over the RGB 127 fill) and its mask, on the model's grid from the window's span start;
 * - condition:k (k ≥ 1): the previous window's result frame at this window's start, the continuity image;
 * - generate:k: one VACE request with the fixed parameters, the frozen seed and the resolved prompt;
 * - composite: the whole presentation in its frozen chunks, each background cropped to `targetRoi` and laid by its PTS;
 * - stitch: the chunks joined with the source's audio into the run's one registered output.
 * A failure ends the output with `{ kind: "expand", windows, shared }`; every window after a failed one is `stopped`.
 */
import { getStorageAdapter, logger } from "@breatic/core";
import type { AcceptedMiniToolExecution } from "@breatic/domain";
import type { MiniToolPlanExact, MiniToolPlanRecipe, MiniToolPlanTarget } from "@breatic/shared";
import { gridSpanFrames, type ExpandFailureReason } from "@breatic/shared/mini-tools";
import type { LipSyncPickup } from "@worker/handlers/mini-tool/run-lip-sync.js";
import { advanceChunks, advanceContainer, advanceGenerate, advanceRegistered, alignedSpanStart, eachSubmitted, exactSeconds, expandFailureReason, modelRunFailure, type ExpandWindowState, type ModelRunAt, type ModelRunPosition, type ModelStepRun } from "@worker/handlers/mini-tool/model-run-steps.js";
import { chunkInputId, segmentTarget, stitchOf, toolInputOf, windowOf } from "@worker/handlers/video-presentation-recipes.js";
import { MiniToolStepFailed } from "@worker/handlers/mini-tool/step-failed.js";
import { StillRunning } from "@worker/handlers/still-running.js";

type Expand = Extract<AcceptedMiniToolExecution, { tool: "video.expand" }>;
type WindowStep = ExpandFailureReason["windows"][number]["step"];

/** The input ids the recipes bind their objects under, fixed so a rebuilt request is the same request. */
const PREVIOUS = "00000000-0000-4000-8004-000000000000";
/**
 * A window's background input id.
 * @param k - The window.
 * @returns A UUID.
 * @throws {never} Never.
 */
const backgroundOf = (k: number): string => `00000000-0000-4000-8008-${String(k).padStart(12, "0")}`;
// The VACE parameters measured in the §8 probe and fixed by execution design §10.5 model row.
const VACE_FIXED = { task: "inpainting", num_inference_steps: 30, guidance_scale: 5, flow_shift: 16, context_scale: 1 } as const;

/**
 * A frozen step key.
 * @param plan - The frozen run.
 * @param step - The step.
 * @returns The key.
 * @throws {Error} When the plan froze none.
 */
function keyOf(plan: Expand, step: string): string {
  const key = plan.stepKeys[step];
  if (key === undefined) throw new Error(`The expand plan froze no key for ${step}`);
  return key;
}

/**
 * The difference of two exact times.
 * @param a - The later.
 * @param b - The earlier.
 * @returns `a − b`.
 * @throws {never} Never.
 */
function minus(a: MiniToolPlanExact, b: MiniToolPlanExact): MiniToolPlanExact {
  return { numerator: a.numerator * b.denominator - b.numerator * a.denominator, denominator: a.denominator * b.denominator };
}

/**
 * The condition picture of window k (§10.5 condition step): the frame of window k − 1's model output at the time window k
 * starts on it. The output is a fixed-rate video from 0 that is not all-intra, so it is read as an original whose keyframe
 * interval spans it, which decodes it from its start (§7.16 原片 row threshold).
 * @param plan - The frozen run.
 * @param k - The window, at least 1.
 * @param offset - Window k's start on window k − 1's output, in seconds.
 * @returns The recipe.
 * @throws {never} Never.
 */
function previousFrameOf(plan: Expand, k: number, offset: MiniToolPlanExact): Extract<MiniToolPlanRecipe, { kind: "frame_at" }> {
  const duration = plan.windows[k - 1]!.duration;
  const frameCount = plan.modelFps * duration;
  // The output frame showing that time: floor(offset × fps), inside the output.
  const frameIndex = Math.min(frameCount - 1, Math.floor((offset.numerator * plan.modelFps) / offset.denominator));
  return { kind: "frame_at", inputId: PREVIOUS, frameIndex, target: plan.frame,
    grid: { fps: { numerator: plan.modelFps, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount, realFrameCount: frameCount },
    source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: duration, allKeyframes: false } } };
}

/**
 * Run one pickup of an expand.
 * @param execution - The frozen run.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @param at - Where the walk stands, kept for the entry's reason when a step throws (§10.5).
 * @returns The output's result once it ended, and whether a step still runs.
 * @throws {Error} When persistence, grants, registration or IO fail.
 */
export async function runMiniToolExpand(execution: unknown, userId: string, deadlineAt: number, at: ModelRunAt = { position: null }): Promise<LipSyncPickup> {
  const plan = execution as Expand;
  const pickup: LipSyncPickup = { results: new Map(), waiting: false };
  const run: ModelStepRun = { taskId: plan.taskId, projectId: plan.projectId, sourceKey: plan.sourceKey, container: plan.container,
    ...(plan.retry === undefined ? {} : { retry: { runId: plan.retry.runId } }), log: "expand" };
  const windows: ExpandWindowState[] = plan.windows.map((_window, windowIndex) => ({ windowIndex, state: "unsubmitted", failure: null }));
  const position: Extract<ModelRunPosition, { tool: "video.expand" }> = { tool: "video.expand", windows, current: { window: 0, step: "window" } };
  at.position = position;
  /**
   * End the output with its reason.
   * @param shared - The failed step outside every window, or null.
   * @returns The pickup.
   * @throws {never} Never.
   */
  const fail = (shared: ExpandFailureReason["shared"]): LipSyncPickup => {
    pickup.results.set(0, { status: "failed", error: expandFailureReason(windows, shared) });
    return pickup;
  };
  /**
   * End the output as the run's expiry: a step whose next attempt was due after the deadline, where the walk stands.
   * @returns The pickup.
   * @throws {never} Never.
   */
  const expire = (): LipSyncPickup => {
    pickup.results.set(0, { status: "failed", error: modelRunFailure("video.expand", position, true) });
    return pickup;
  };
  try {
    // Every recipe reads the frozen version's grid frames from its tool source (§7.16).
    const version = plan.presentations.source;
    const { display } = version;
    const tool = toolInputOf(version, plan.sourceKey);
    const source = tool.inputs.slice(0, 1);
    const encoded = segmentTarget(version, plan.container.encode);
    const storage = await getStorageAdapter();
    const spans = plan.windows.map((window) => ({ start: exactSeconds(window.span.start), end: exactSeconds(window.span.end) }));
    const results: string[] = [];
    for (const [k, window] of plan.windows.entries()) {
      // The grid frames the window's span touches; the span is the model grid's origin and length.
      const frames = gridSpanFrames(window.span, display.fps, display.frameCount);
      // The frozen float start is the opening frame's grid time when it lies within float precision below it.
      const opening = { numerator: frames.start * display.fps.denominator, denominator: display.fps.numerator };
      spans[k] = { ...spans[k]!, start: alignedSpanStart(spans[k]!.start, opening) };
      const model = { fps: plan.modelFps, frameCount: plan.modelFps * window.duration };
      const layer: MiniToolPlanTarget = { ...encoded, width: plan.sourceRoi.width, height: plan.sourceRoi.height, displayRect: null, format: undefined };
      // Each step names itself just before it runs, so a step that throws leaves the run standing at it (§10.5).
      const [input, mask, condition] = await eachSubmitted([
        () => { position.current = { window: k, step: "window" }; return advanceContainer(run, { stepKey: keyOf(plan, `window:${k}`), contentType: "video/mp4", failed: () => ({ failed: "failed", step: "window" }),
          build: () => Promise.resolve({ recipe: { kind: "model_window", ...windowOf(tool, frames, layer), model, frame: plan.frame, sourceRoi: plan.sourceRoi,
            fill: [127, 127, 127], span: spans[k]! }, inputs: source }) }, deadlineAt); },
        () => { position.current = { window: k, step: "window_mask" }; return advanceContainer(run, { stepKey: keyOf(plan, `window_mask:${k}`), contentType: "video/mp4", failed: () => ({ failed: "failed", step: "window_mask" }),
          build: () => Promise.resolve({ recipe: { kind: "model_window_mask", model, frame: plan.frame, sourceRoi: plan.sourceRoi, span: spans[k]! }, inputs: [] }) }, deadlineAt); },
        ...(k === 0 ? [] : [() => { position.current = { window: k, step: "condition" }; return advanceContainer(run, { stepKey: keyOf(plan, `condition:${k}`), contentType: "image/png", failed: () => ({ failed: "failed", step: "condition" }),
          build: () => Promise.resolve({ recipe: previousFrameOf(plan, k, minus(spans[k]!.start, spans[k - 1]!.start)),
            inputs: [{ inputId: PREVIOUS, storageKey: results[k - 1]! }] }) }, deadlineAt); }]),
      ]);
      for (const ended of [input, mask, condition]) {
        if (ended !== undefined && !("key" in ended)) {
          if (ended.expired === true) { position.current = { window: k, step: ended.step as WindowStep }; return expire(); }
          windows[k]!.failure = { step: ended.step as WindowStep, category: "failed" };
          return fail(null);
        }
      }
      position.current = { window: k, step: "generate" };
      windows[k]!.state = "submitted";
      const ended = await advanceGenerate(run, { route: plan.route, model: plan.model, itemIndex: k, stepKey: keyOf(plan, `generate:${k}`), contentType: "video/mp4",
        input: () => Promise.resolve({ prompt: plan.prompt, params: { video: storage.publicUrl((input as { key: string }).key), mask_video: storage.publicUrl((mask as { key: string }).key),
          ...VACE_FIXED, size: plan.size, duration: window.duration, seed: plan.seed,
          ...(condition === undefined ? {} : { image: storage.publicUrl((condition as { key: string }).key) }) } }) }, userId, deadlineAt);
      if (!("key" in ended)) {
        if (ended.expired === true) return expire();
        windows[k]!.failure = { step: "generate", category: ended.failed as "model_rejected" | "timeout" | "failed" };
        return fail(null);
      }
      windows[k]!.state = "done";
      results.push(ended.key);
    }
    position.current = { shared: "composite" };
    const output: MiniToolPlanTarget & { format?: "mp4-h264" | "webm-vp9" } = { ...encoded, width: plan.layout.width, height: plan.layout.height,
      displayRect: { x: plan.layout.sourceX, y: plan.layout.sourceY, width: display.width, height: display.height } };
    const chunks = await advanceChunks(run, plan.composite.map((chunk, c) => {
      // The windows whose span overlaps the chunk's grid time [start / fps, end / fps).
      const [from, to] = [chunk.start / (display.fps.numerator / display.fps.denominator), chunk.end / (display.fps.numerator / display.fps.denominator)];
      const shown = plan.windows.flatMap((window, k) => (window.span.start < to && window.span.end > from ? [k] : []));
      return { stepKey: keyOf(plan, `composite:${c}`), contentType: "video/mp4", failed: () => ({ failed: "failed" }),
        build: () => Promise.resolve({ recipe: { kind: "model_composite" as const, mode: "expand" as const, ...windowOf(tool, chunk, { ...output, format: undefined }),
          backgrounds: shown.map((k) => ({ inputId: backgroundOf(k), window: spans[k]!, crop: plan.targetRoi })) },
        inputs: [...source, ...shown.map((k) => ({ inputId: backgroundOf(k), storageKey: results[k]! }))] }) };
    }), deadlineAt);
    if (!("keys" in chunks)) return chunks.expired === true ? expire() : fail({ step: "composite", category: "failed" });
    position.current = { shared: "stitch" };
    const written = await advanceRegistered(run, { stepKey: keyOf(plan, "stitch"), namePrefix: "EXPAND", container: output.format === "webm-vp9" ? "webm" : "mp4",
      build: () => Promise.resolve({ recipe: stitchOf(tool, plan.composite, output, true),
      inputs: [...tool.inputs, ...chunks.keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey }))] }) }, userId, deadlineAt);
    if ("failed" in written) return written.expired === true ? expire() : fail({ step: "stitch", category: "failed" });
    pickup.results.set(0, written);
    return pickup;
  } catch (error) {
    if (error instanceof StillRunning) { pickup.waiting = true; return pickup; }
    // Only the recipe targets throw this here; a provider's failure is caught where it is called.
    if (error instanceof MiniToolStepFailed) {
      const { current } = position;
      logger.error({ err: error, ctx: { taskId: plan.taskId, current } }, "mini_tool_expand_step_failed");
      if ("shared" in current) return fail({ step: current.shared, category: "failed" });
      windows[current.window]!.failure = { step: current.step, category: "failed" };
      return fail(null);
    }
    throw error;
  }
}
