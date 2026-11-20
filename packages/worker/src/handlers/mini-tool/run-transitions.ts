// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The transitions runner on the frozen plan (frames-split design §5.4 dispatch, budget and job identity rows; §7.17
 * `chunk_encode`, `transition_window` and `stitch` rows; §97 D23-3). Each pickup rebuilds the frame-grid timeline from the
 * frozen clips and profile and sends every frozen chunk as it is: a `chunk_encode` on the frozen `container` class for
 * each encode window, on the clip it lies in; a `transition_window` on the frozen `windowContainer` class for each window
 * chunk, over both clips' grid frames for those output frames; then one registered `stitch` over every chunk in output order with
 * both clips' audio and the crossfade window (none for a Cut). Every job carries the frozen profile.
 */
import type { AcceptedMiniToolExecution } from "@breatic/domain";
import { videoPresentationWorkKeyFor, type MiniToolPlanRecipe, type MiniToolPlanTarget } from "@breatic/shared";
import { planVideoTimeline, transitionFitRect, videoContainerJobId, type FrameWindow, type VideoContainerJobSpec, type VideoToolDraftById } from "@breatic/shared/mini-tools";
import { advanceChunks, advanceRegistered, type ContainerStep } from "@worker/handlers/mini-tool/model-run-steps.js";
import { failedResult, type VideoToolPickup } from "@worker/handlers/mini-tool/run-video-tool.js";
import { planColorOf } from "@worker/handlers/frozen-plan-facts.js";
import { chunkInputId, chunkRefsOf, toolInputOf, type ToolInput } from "@worker/handlers/video-presentation-recipes.js";
import { StillRunning } from "@worker/handlers/still-running.js";

type Transitions = Extract<AcceptedMiniToolExecution, { tool: "video.transitions" }>;
/** One clip as the runner reads it: its frozen version, its tool source and its place on the output grid. */
interface Clip { version: Transitions["presentations"][string]; input: ToolInput; placement: { startFrame: number; inFrame: number }; frameCount: number }

/**
 * The input id a job binds clip `at` under: fixed per clip, so a rebuilt request is the same request.
 * @param at - The clip's position in the timeline.
 * @returns A UUID distinct from a chunk's.
 * @throws {never} Never.
 */
const clipInputId = (at: number): string => `00000000-0000-4000-8002-${String(at).padStart(12, "0")}`;
/**
 * The input id a stitch reads clip `at`'s original audio under, when its frames come from an edit file (§4.4).
 * @param at - The clip's position in the timeline.
 * @returns A UUID distinct from a chunk's and a clip's.
 * @throws {never} Never.
 */
const clipAudioId = (at: number): string => `00000000-0000-4000-8003-${String(at).padStart(12, "0")}`;

/**
 * The target of a transition chunk: the output profile's own (§7.17 transition output profile row), the clip in its fitted
 * rectangle.
 * @param profile - The frozen profile.
 * @param fit - Where the clip sits on the output frame.
 * @returns The target.
 * @throws {never} Never.
 */
function profileTarget(profile: Extract<MiniToolPlanRecipe, { kind: "transition_window" }>["profile"], fit: MiniToolPlanTarget["displayRect"]): MiniToolPlanTarget {
  return { width: profile.width, height: profile.height, displayRect: fit, colorMatrix: profile.color.matrix, toneMap: "none", alpha: profile.alpha ? "straight" : "none",
    crf: profile.encode.crf, preset: profile.encode.preset, format: profile.codec === "vp9" ? "webm-vp9" : "mp4-h264" };
}

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
 * One pickup of a transitions run.
 * @param execution - The frozen run.
 * @param userId - Who ran the tool.
 * @param deadlineAt - The task deadline.
 * @returns The one output once it is settled, and whether a job still runs.
 * @throws {Error} When persistence, grants or registration fail.
 */
export async function runMiniToolTransitions(execution: AcceptedMiniToolExecution, userId: string, deadlineAt: number): Promise<VideoToolPickup> {
  if (execution.tool !== "video.transitions") throw new Error("A transitions runner requires a transitions run");
  const { layout } = execution;
  // The frozen profile was built with the configured x264 preset; the plan hash binds it.
  const profile = execution.profile as Extract<MiniToolPlanRecipe, { kind: "transition_window" }>["profile"];
  const draft = execution.draft as VideoToolDraftById["video.transitions"];
  const timeline = planVideoTimeline(draft.params.clips, profile.fps);
  // Each clip's frozen version gives its grid and tool source (§7.16); the container places its grid frames on the output.
  const clips: Clip[] = timeline.clips.map((placed, at) => {
    const version = execution.presentations[placed.inputId]!;
    return { version, input: toolInputOf(version, execution.sourceKeys[placed.inputId]!, clipInputId(at), clipAudioId(at)),
      placement: { startFrame: placed.startFrame, inFrame: placed.inFrame }, frameCount: placed.frameCount };
  });
  const pickup: VideoToolPickup = { results: new Map(), waiting: false };
  const boundary = timeline.window?.startFrame ?? clips[1]!.placement.startFrame;
  // Where each clip sits on the output frame, the one rectangle its encode and window chunks use (§7.17).
  const fits = clips.map((clip) => transitionFitRect(clip.version.display, profile));
  const planned: { window: FrameWindow; step: ContainerStep }[] = [];
  for (const [k, window] of layout.encode.entries()) {
    const at = window.end <= boundary ? 0 : 1;
    const clip = clips[at]!;
    planned.push({ window, step: workChunk(execution, (attempt) => ({ kind: "run-chunk", taskId: execution.taskId, output: 0, chunk: k, attempt }), execution.container.containerClass, () => ({
      recipe: { kind: "chunk_encode", inputId: clip.input.inputId, grid: clip.input.grid, source: clip.input.source, frames: { start: window.start, end: window.end },
        target: profileTarget(profile, fits[at]!), profile, placement: clip.placement },
      inputs: clip.input.inputs.slice(0, 1) })) });
  }
  for (const [k, frames] of layout.window.entries()) {
    const window = timeline.window!;
    planned.push({ window: frames, step: workChunk(execution, (attempt) => ({ kind: "run-window", taskId: execution.taskId, output: 0, chunk: k, attempt }), execution.windowContainer.containerClass, () => ({
      recipe: { kind: "transition_window", frames: { start: frames.start, end: frames.end }, window: { startFrame: window.startFrame, frameCount: window.frameCount },
        transition: window.kind, profile,
        // Each clip converts by its own plan's matrix and tone mapping before the blend (§97 D23-4).
        clips: clips.map((clip, at) => {
          const { colorMatrix, toneMap } = planColorOf(clip.version);
          return { inputId: clip.input.inputId, grid: clip.input.grid, source: clip.input.source, placement: clip.placement, colorMatrix, toneMap, fit: fits[at]! };
        }) as [never, never] },
      inputs: clips.map((clip) => clip.input.inputs[0]!),
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
  let written: Awaited<ReturnType<typeof advanceRegistered>>;
  try {
    written = await advanceRegistered({ taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container, log: "transitions" },
      { stepKey: "out:0:stitch", namePrefix: "TRANSITION", container: profile.alpha ? "webm" : "mp4", retire: chunks.map((chunk) => chunk.key), build: () => {
        // Each clip's original audio over exactly the output frames it shows, from its in-frame; a source with no audio track
        // is played as silence by the stitch (D16-1). The original is the tool source itself, or bound beside its edit file.
        const originals = clips.map((clip) => clip.input.inputs.at(-1)!);
        return Promise.resolve({ inputs: [...originals, ...chunks.map((chunk, at) => ({ inputId: chunkInputId(at), storageKey: chunk.key }))],
          recipe: { kind: "stitch", profile, chunks: chunkRefsOf(chunks),
            clips: clips.map((clip, at) => ({ inputId: originals[at]!.inputId, grid: clip.input.grid, placement: clip.placement, frameCount: clip.frameCount, audio: true })) as [never, never],
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
