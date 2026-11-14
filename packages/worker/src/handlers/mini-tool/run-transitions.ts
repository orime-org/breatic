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
import { transitionSlotTime, transitionSourceWindow, type AcceptedMiniToolExecution } from "@breatic/domain";
import { videoPresentationWorkKeyFor, type MiniToolPlanExact, type MiniToolPlanRecipe, type VideoPresentationLedger } from "@breatic/shared";
import { planVideoTimeline, videoContainerJobId, type FrameWindow, type VideoContainerJobSpec, type VideoToolDraftById } from "@breatic/shared/mini-tools";
import { advanceChunks, advanceRegistered, type ContainerStep } from "@worker/handlers/mini-tool/model-run-steps.js";
import { failedResult, type VideoToolPickup } from "@worker/handlers/mini-tool/run-video-tool.js";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { audioOf, chunkInputId, FullLedgerInvalid, readJobLedger, segmentTarget, windowEntries } from "@worker/handlers/video-presentation-recipes.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";

type Transitions = Extract<AcceptedMiniToolExecution, { tool: "video.transitions" }>;
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
 * One unregistered work chunk: a done output is pinned with the run and a failed attempt's output is retired with its result.
 * @param execution - The run.
 * @param spec - The chunk's §5.4 id per attempt.
 * @param containerClass - The class it runs on.
 * @param build - Its recipe and bound inputs.
 * @returns The chunk step.
 * @throws {never} Never.
 */
function workChunk(execution: Transitions, spec: (attempt: number) => VideoContainerJobSpec, containerClass: string,
  build: () => { recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[] }): ContainerStep {
  /**
   * The chunk's job id of an attempt.
   * @param attempt - The attempt.
   * @returns The id.
   * @throws {never} Never.
   */
  const jobId = (attempt: number): string => videoContainerJobId(spec(attempt));
  return { contentType: execution.profile.alpha ? "video/webm" : "video/mp4", jobId, containerClass,
    limits: containerClass === execution.windowContainer.containerClass ? execution.windowContainer.limits : execution.container.limits,
    outputKey: (id) => videoPresentationWorkKeyFor(execution.sourceKey, id), failed: (reason) => ({ failed: reason }), build: () => Promise.resolve(build()) };
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
      ledger: await readJobLedger(execution.ledgerReceipts[placed.inputId]!, planReadUntil(deadlineAt)), startFrame: placed.startFrame, inFrame: placed.inFrame, frameCount: placed.frameCount })));
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    // The receipts are frozen for the run, so a ledger that fails one never recovers here (§91 D3b-9).
    logger.error({ err: error, ctx: { taskId: execution.taskId } }, "mini_tool_transitions_ledger_invalid");
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
  const pickup: VideoToolPickup = { results: new Map(), waiting: false };
  const boundary = timeline.window?.startFrame ?? clips[1]!.startFrame;
  /**
   * A clip's recipe fields over output frames: its picture starts at the first output frame's time, so the chunk's frame
   * grid lines up with the output's (§5.4 chunking row).
   * @param at - The clip.
   * @param frames - The output frames.
   * @returns Its entries and window.
   * @throws {RangeError} When the frames lie outside the clip.
   */
  const over = (at: number, frames: FrameWindow): { window: FrameWindow; entries: ReturnType<typeof windowEntries> } => {
    const window = transitionSourceWindow(clips[at]!.ledger.plan.presentation, clips[at]!, frames, profile.fps);
    return { window, entries: windowEntries(clips[at]!.ledger, window, exact(...transitionSlotTime(clips[at]!, frames.start, profile.fps))) };
  };
  const planned: { window: FrameWindow; step: ContainerStep }[] = [];
  for (const [k, window] of layout.encode.entries()) {
    const at = window.end <= boundary ? 0 : 1;
    planned.push({ window, step: workChunk(execution, (attempt) => ({ kind: "run-chunk", taskId: execution.taskId, output: 0, chunk: k, attempt }), execution.container.containerClass, () => {
      const { window: source, entries } = over(at, window);
      return { recipe: { kind: "chunk_encode", inputId: clipInputId(at), window: source, timescale: clips[at]!.ledger.plan.presentation.timescale, entries,
        target: segmentTarget(clips[at]!.ledger, execution.container.encode), profile, frames: { start: window.start, end: window.end } }, inputs: [{ inputId: clipInputId(at), storageKey: clips[at]!.storageKey }] };
    }) });
  }
  for (const [k, frames] of layout.window.entries()) {
    const window = timeline.window!;
    planned.push({ window: frames, step: workChunk(execution, (attempt) => ({ kind: "run-window", taskId: execution.taskId, output: 0, chunk: k, attempt }), execution.windowContainer.containerClass, () => ({
      recipe: { kind: "transition_window", frames: { start: frames.start, end: frames.end }, window: { startFrame: window.startFrame, frameCount: window.frameCount },
        transition: window.kind, profile,
        clips: [0, 1].map((at) => ({ inputId: clipInputId(at), entries: over(at, frames).entries, colorMatrix: clips[at]!.ledger.plan.colorMatrix,
          toneMap: clips[at]!.ledger.plan.output.toneMap })) as [never, never] },
      inputs: clips.map((clip, at) => ({ inputId: clipInputId(at), storageKey: clip.storageKey })),
    })) });
  }
  // Every encode and window chunk advances in each pickup (§5.4 parallel stage); the output settles once none still runs.
  let ended: Awaited<ReturnType<typeof advanceChunks>>;
  try {
    ended = await advanceChunks({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "transitions" },
      planned.map((chunk) => chunk.step), deadlineAt);
  } catch (error) {
    if (!(error instanceof StillRunning)) throw error;
    pickup.waiting = true;
    return pickup;
  }
  if (!("keys" in ended)) { pickup.results.set(0, failedResult(ended.failed)); return pickup; }
  const { keys } = ended;
  const chunks = planned.map((chunk, at) => ({ ...chunk.window, key: keys[at]! })).sort((left, right) => left.start - right.start);
  const [fpsNumerator, fpsDenominator] = [BigInt(profile.fps.numerator), BigInt(profile.fps.denominator)];
  let written: Awaited<ReturnType<typeof advanceRegistered>>;
  try {
    written = await advanceRegistered({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "transitions" },
      { stepKey: "out:0:stitch", namePrefix: "TRANSITION", container: profile.alpha ? "webm" : "mp4", retire: chunks.map((chunk) => chunk.key), build: () => {
        // Each clip's audio over exactly the time its output frames show, from its first slot for frameCount / fps, so its sound
        // starts and ends with its picture; a source with no audio track is played as silence by the stitch (D16-1).
        const audio = clips.map((clip) => {
          const [numerator, denominator] = transitionSlotTime(clip, clip.startFrame, profile.fps);
          const end = exact(numerator * fpsNumerator + BigInt(clip.frameCount) * fpsDenominator * denominator, denominator * fpsNumerator);
          return audioOf(clip.ledger, { start: exact(numerator, denominator), end });
        });
        return Promise.resolve({ inputs: [...clips.map((clip, at) => ({ inputId: clipInputId(at), storageKey: clip.storageKey })), ...chunks.map((chunk, at) => ({ inputId: chunkInputId(at), storageKey: chunk.key }))],
          recipe: { kind: "stitch", profile,
            chunks: chunks.map((chunk, at) => ({ inputId: chunkInputId(at), duration: exact(BigInt(chunk.end - chunk.start) * fpsDenominator, fpsNumerator) })),
            clips: clips.map((_clip, at) => ({ inputId: clipInputId(at), audio: audio[at]! })) as [never, never],
            crossfade: timeline.window === null ? null : { startFrame: timeline.window.startFrame, frameCount: timeline.window.frameCount } } });
      } }, userId, deadlineAt);
  } catch (error) {
    if (!(error instanceof StillRunning)) throw error;
    pickup.waiting = true;
    return pickup;
  }
  pickup.results.set(0, "failed" in written ? failedResult(written.failed) : written);
  return pickup;
}
