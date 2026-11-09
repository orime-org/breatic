// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The transitions runner on the frozen plan (frames-split design §5.4 dispatch, budget and job identity rows; §7.17
 * `chunk_encode`, `transition_window` and `stitch` rows; §97 D23-3). Each pickup rebuilds the frame-grid timeline from the
 * frozen clips and profile and sends every frozen chunk as it is: a `chunk_encode` on the frozen `container` class for
 * each encode window, on the clip it lies in; a `transition_window` on the frozen `windowContainer` class for each window
 * chunk, over both clips' entries for those frames; then one registered `stitch` over every chunk in output order with
 * both clips' audio and the crossfade window (none for a Cut). Every job carries the frozen profile.
 */
import { logger } from "@breatic/core";
import { miniToolStepStateSchema, openContainerOutputs, openMiniToolPlanJob, recordMiniToolStepResult, upstreamStepRepo, type AcceptedMiniToolExecution } from "@breatic/domain";
import {
  miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, videoPresentationWorkKeyFor, type MiniToolPlanExact, type MiniToolPlanJobRequest, type MiniToolPlanRecipe,
  type VideoPresentationLedger,
} from "@breatic/shared";
import { planVideoTimeline, presentationCoveringFrame, videoContainerJobId, type FrameWindow, type VideoContainerJobSpec, type VideoToolDraftById } from "@breatic/shared/mini-tools";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { advanceRegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { registered, type VideoToolPickup } from "@worker/handlers/mini-tool/run-video-tool.js";
import { audioOf, chunkInputId, FullLedgerInvalid, readJobLedger, segmentTarget, windowEntries, windowInterval } from "@worker/handlers/video-presentation-recipes.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";

type Transitions = Extract<AcceptedMiniToolExecution, { tool: "video.transitions" }>;
type Step = Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number];
/** One clip as the runner reads it: its input, source key, ledger and place on the output grid. */
interface Clip { inputId: string; storageKey: string; ledger: VideoPresentationLedger; startFrame: number; inFrame: number; frameCount: number }

/**
 * The input id a job binds clip `at` under: fixed per clip, so a rebuilt request is the same request.
 * @param at - The clip's position in the timeline.
 * @returns A UUID distinct from a chunk's.
 * @throws {never} Never.
 */
const clipInputId = (at: number): string => `00000000-0000-4000-8002-${String(at).padStart(12, "0")}`;

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
 * The step of a job id: the one whose stored request names it, else a new one appended after the task's steps.
 * @param execution - The run.
 * @param jobId - The job id.
 * @param endpoint - The class the job runs on.
 * @returns The step and its stored request, if it has one.
 * @throws {Error} When persistence fails.
 */
async function stepOf(execution: Transitions, jobId: string, endpoint: string): Promise<{ step: Step; request: MiniToolPlanJobRequest | null }> {
  const steps = await upstreamStepRepo.listSteps(execution.taskId);
  const found = steps.find((step) => storedRequest(step)?.jobId === jobId);
  if (found !== undefined) return { step: found, request: storedRequest(found) };
  const position = steps.length;
  const rows = await upstreamStepRepo.ensureSteps(execution.taskId, [...steps.map(({ kind, endpoint: e, itemIndex }) => ({ kind, endpoint: e, itemIndex })),
    { kind: "container_job", endpoint, itemIndex: position }]);
  const appended = rows.find((step) => step.position === position);
  if (appended === undefined) throw new Error("Appended transitions step disappeared");
  return { step: appended, request: null };
}

/**
 * The source presentation frames a clip shows over output frames `[start, end)`: the frame covering each output frame's middle.
 * @param clip - The clip.
 * @param output - The output frames.
 * @param fps - The output frame rate.
 * @param fps.numerator - Its numerator.
 * @param fps.denominator - Its denominator.
 * @returns The source window.
 * @throws {RangeError} When a time lies outside the clip's presentation.
 */
function sourceWindow(clip: Clip, output: FrameWindow, fps: { numerator: string; denominator: string }): FrameWindow {
  const seconds = Number(fps.denominator) / Number(fps.numerator);
  const table = clip.ledger.plan.presentation;
  /**
   * The source frame covering an output frame's middle.
   * @param k - The output frame.
   * @returns The source frame.
   * @throws {never} Never.
   */
  const at = (k: number): number => presentationCoveringFrame(table, (clip.inFrame + k - clip.startFrame + 0.5) * seconds);
  return { start: at(output.start), end: at(output.end - 1) + 1 };
}

/**
 * Advance one unregistered work chunk up to the frozen retries; a done output is pinned with the run and a failed
 * attempt's output is retired with its result.
 * @param execution - The run.
 * @param spec - The chunk's §5.4 id per attempt.
 * @param containerClass - The class it runs on.
 * @param build - Its recipe and bound inputs.
 * @param deadlineAt - The task deadline.
 * @returns The done work key, null while it runs, or the failure reason once the retries are spent.
 * @throws {Error} When persistence or the job boundary fails.
 */
async function advanceWork(execution: Transitions, spec: (attempt: number) => VideoContainerJobSpec, containerClass: string,
  build: () => { recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }, deadlineAt: number): Promise<string | null | { failed: string }> {
  let reason = "tool_failed";
  const limits = containerClass === execution.windowContainer.containerClass ? execution.windowContainer.limits : execution.container.limits;
  for (let attempt = 1; attempt <= execution.container.chunkRetries + 1; attempt += 1) {
    const jobId = videoContainerJobId(spec(attempt));
    const { step, request: stored } = await stepOf(execution, jobId, containerClass);
    const state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
    if (stored !== null && state?.result?.outcome === "failed") {
      const failed = readMiniToolPlanJobReport(stored, state.result.result);
      if (failed.state === "failed") reason = failed.reason;
      continue;
    }
    if (stored !== null && state?.result?.outcome === "done") return stored.outputs[0]!.storageKey;
    const built = stored === null ? build() : null;
    const candidate: MiniToolPlanJobRequest = stored ?? { schemaVersion: 2, jobId, containerClass, deadlineAt, limits, inputs: built!.inputs,
      outputs: [{ outputIndex: 0, storageKey: videoPresentationWorkKeyFor(execution.sourceKey, jobId), contentType: execution.profile.alpha ? "video/webm" : "video/mp4", recipe: built!.recipe }] };
    const { request, consumption } = await openMiniToolPlanJob({ taskId: execution.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: "user", request: candidate });
    let answer: Awaited<ReturnType<typeof advanceMiniToolPlanJob>>;
    try {
      answer = await advanceMiniToolPlanJob(request);
    } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      return null;
    }
    const report = readMiniToolPlanJobReport(request, answer);
    if (report.state !== "done" && report.state !== "failed") return null;
    const key = request.outputs[0]!.storageKey;
    await recordMiniToolStepResult({ taskId: execution.taskId, stepId: step.id, identity: consumption.identity, outcome: report.state, result: report,
      ...(report.state === "failed" ? { error: { code: report.reason }, presentation: { retire: [key] } } : { presentation: { pin: [key] } }) },
    { kind: "container_job", parse: (value) => readMiniToolPlanJobReport(request, value) });
    if (report.state === "done") return key;
    reason = report.reason;
  }
  return { failed: reason };
}

/**
 * A reduced exact fraction.
 * @param numerator - The numerator.
 * @param denominator - The positive denominator.
 * @returns It.
 * @throws {never} Never.
 */
function exact(numerator: bigint, denominator: bigint): MiniToolPlanExact {
  let [a, b] = [numerator, denominator];
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: String(numerator / a), denominator: String(denominator / a) };
}

/**
 * One pickup of a transitions run.
 * @param execution - The frozen run.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @returns The one output once it is settled, and whether a job still runs.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when a frozen ledger fails its receipt.
 * @throws {Error} When a read in transport, persistence, grants or registration fail.
 */
export async function runMiniToolTransitions(execution: AcceptedMiniToolExecution, userId: string, deadlineAt: number): Promise<VideoToolPickup> {
  if (execution.tool !== "video.transitions") throw new Error("A transitions runner requires a transitions run");
  const { layout } = execution;
  // The frozen profile was built with the configured x264 preset; the plan hash binds it.
  const profile = execution.profile as Extract<MiniToolPlanRecipe, { kind: "transition_window" }>["profile"];
  const draft = execution.draft as VideoToolDraftById["video.transitions"];
  const timeline = planVideoTimeline(draft.params.clips, profile.fps);
  let clips: Clip[];
  try {
    clips = await Promise.all(timeline.clips.map(async (placed) => ({ inputId: placed.inputId, storageKey: execution.sourceKeys[placed.inputId]!,
      ledger: await readJobLedger(execution.ledgerReceipts[placed.inputId]!, deadlineAt), startFrame: placed.startFrame, inFrame: placed.inFrame, frameCount: placed.frameCount })));
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    // The receipts are frozen for the run, so a ledger that fails one never recovers here (§91 D3b-9).
    logger.error({ err: error, ctx: { taskId: execution.taskId } }, "mini_tool_transitions_ledger_invalid");
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
  const pickup: VideoToolPickup = { results: new Map(), waiting: false };
  const boundary = timeline.window?.startFrame ?? clips[1]!.startFrame;
  /**
   * A clip's recipe fields over output frames.
   * @param at - The clip.
   * @param frames - The output frames.
   * @returns Its entries and window.
   * @throws {RangeError} When the frames lie outside the clip.
   */
  const over = (at: number, frames: FrameWindow): { window: FrameWindow; entries: ReturnType<typeof windowEntries> } => {
    const window = sourceWindow(clips[at]!, frames, profile.fps);
    return { window, entries: windowEntries(clips[at]!.ledger, window) };
  };
  const chunks: { start: number; end: number; key: string | null }[] = [];
  let failed: string | null = null;
  /**
   * Note a chunk's outcome.
   * @param window - Its output frames.
   * @param done - The work key, null while it runs, or its failure.
   * @throws {never} Never.
   */
  const note = (window: FrameWindow, done: string | null | { failed: string }): void => {
    if (done !== null && typeof done !== "string") { failed ??= done.failed; return; }
    if (done === null) pickup.waiting = true;
    chunks.push({ ...window, key: done });
  };
  for (const [k, window] of layout.encode.entries()) {
    const at = window.end <= boundary ? 0 : 1;
    note(window, await advanceWork(execution, (attempt) => ({ kind: "run-chunk", taskId: execution.taskId, output: 0, chunk: k, attempt }), execution.container.containerClass, () => {
      const { window: source, entries } = over(at, window);
      return { recipe: { kind: "chunk_encode", inputId: clipInputId(at), window: source, timescale: clips[at]!.ledger.plan.presentation.timescale, entries,
        target: segmentTarget(clips[at]!.ledger, execution.container.encode), profile }, inputs: [{ inputId: clipInputId(at), storageKey: clips[at]!.storageKey }] };
    }, deadlineAt));
  }
  for (const [k, frames] of layout.window.entries()) {
    const window = timeline.window!;
    note(frames, await advanceWork(execution, (attempt) => ({ kind: "run-window", taskId: execution.taskId, output: 0, chunk: k, attempt }), execution.windowContainer.containerClass, () => ({
      recipe: { kind: "transition_window", frames: { start: frames.start, end: frames.end }, window: { startFrame: window.startFrame, frameCount: window.frameCount },
        transition: window.kind, profile,
        clips: [0, 1].map((at) => ({ inputId: clipInputId(at), entries: over(at, frames).entries, colorMatrix: clips[at]!.ledger.plan.colorMatrix,
          toneMap: clips[at]!.ledger.plan.output.toneMap })) as [never, never] },
      inputs: clips.map((clip, at) => ({ inputId: clipInputId(at), storageKey: clip.storageKey })),
    }), deadlineAt));
  }
  if (failed !== null) { pickup.results.set(0, { status: "failed", error: { code: "mini_tool_failed", message: failed } }); return pickup; }
  if (pickup.waiting) return pickup;
  chunks.sort((left, right) => left.start - right.start);
  const [fpsNumerator, fpsDenominator] = [BigInt(profile.fps.numerator), BigInt(profile.fps.denominator)];
  for (let attempt = 1; attempt <= execution.container.chunkRetries + 1; attempt += 1) {
    const jobId = videoContainerJobId({ kind: "run-stitch", taskId: execution.taskId, output: 0, attempt });
    const { step, request: stored } = await stepOf(execution, jobId, execution.container.containerClass);
    let request = stored;
    if (request === null) {
      const [grant] = await openContainerOutputs({ projectId: execution.projectId, actingUserId: userId, taskId: execution.taskId, deadlineAt,
        outputs: [{ modality: "video", namePrefix: "TRANSITION", ...(profile.alpha ? { container: "webm" as const } : {}) }] });
      if (grant === undefined) throw new Error("The transition output requires its upload grant");
      // Each clip's audio over the frames it plays; a source with no audio track is played as silence by the stitch (D16-1).
      const audio = clips.map((clip) => audioOf(clip.ledger, windowInterval(clip.ledger, sourceWindow(clip, { start: clip.startFrame, end: clip.startFrame + clip.frameCount }, profile.fps))));
      request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId, containerClass: execution.container.containerClass, deadlineAt, limits: execution.container.limits,
        inputs: [...clips.map((clip, at) => ({ inputId: clipInputId(at), storageKey: clip.storageKey })), ...chunks.map((chunk, at) => ({ inputId: chunkInputId(at), storageKey: chunk.key! }))],
        outputs: [{ ...grant, outputIndex: 0, recipe: { kind: "stitch", profile,
          chunks: chunks.map((chunk, at) => ({ inputId: chunkInputId(at), duration: exact(BigInt(chunk.end - chunk.start) * fpsDenominator, fpsNumerator) })),
          clips: clips.map((_clip, at) => ({ inputId: clipInputId(at), audio: audio[at]! })),
          crossfade: timeline.window === null ? null : { startFrame: timeline.window.startFrame, frameCount: timeline.window.frameCount } } }] });
    }
    let job: Awaited<ReturnType<typeof advanceRegisteredMiniToolPlanJob>>;
    try {
      job = await advanceRegisteredMiniToolPlanJob({ taskId: execution.taskId, stepId: step.id, chunkIndex: step.position, chargeTo: "user", request },
        { retire: chunks.map((chunk) => chunk.key!) });
    } catch (error) {
      if (!(error instanceof StillRunning)) throw error;
      pickup.waiting = true;
      return pickup;
    }
    const written = job.assets.find((entry) => entry.outputIndex === 0);
    if (job.report.state === "done" && written !== undefined) { pickup.results.set(0, await registered(written.asset)); return pickup; }
    if (attempt === execution.container.chunkRetries + 1) {
      pickup.results.set(0, { status: "failed", error: { code: "mini_tool_failed", message: job.report.state === "failed" ? job.report.reason : "tool_failed" } });
    }
  }
  return pickup;
}
