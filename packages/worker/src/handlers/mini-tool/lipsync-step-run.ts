// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One lip-sync step on the frozen plan (multi-person lip-sync DD §7.2; execution design §10.2): prepare, the shared tracking
 * clips, a person's tracks and their join, faces, clip, stem and gen, then the shared composite and stitch. The runner
 * (`run-lip-sync.ts`) calls it each pickup; a finished step answers `done` again without being redone. The steps run on the
 * tool-independent runner of `model-run-steps.ts` (§10.7).
 *
 * - prepare: the model-input preparation of the used source range (the removal's preparation, frames-split §5.3).
 * - prepare:fwd, prepare:rev: the tracker takes its prompt on frame 0 only, so the anchor a of the prepared frames [0, e)
 *   is tracked on [a, e) (the preparation itself when a = 0) and, when a > 0, on [0, a] played backwards.
 * - track:fwd, track:rev, gen: `generate` steps (execution design §9.1, §9.3), the submit intent stored before the provider is
 *   called; the provider's temporary link is fetched by the ingest Worker into `${stepKey}:${attemptId}` (§97 D21-1),
 *   recorded with the step result and appended to the run's execution pin in that transaction, with no asset row.
 * - track_join, faces, clip, stem, composite: standard-4 container jobs with the §7.17 recipes; the job id is
 *   `${taskId}:${stepKey}:a${attempt}`, the output key `stepWorkKey(sourceKey, jobId, contentType)` (the work key plus the
 *   type's extension; §97 D21-2), pinned with the run; retried up to the frozen `chunkRetries`.
 * - stitch: one registered job over the composite chunks with every person's stem summed (§97 D22-3).
 * - a retry finds each done step of the original run by its frozen step key and reuses its object (§97 D21-6).
 */
import { z } from "zod";
import { getMiniToolsConfig, getStorageAdapter, logger } from "@breatic/core";
import {
  lipsyncPersonStepKeys, type AcceptedMiniToolExecution, type LipSyncPersonStep, type MiniToolStepJson,
} from "@breatic/domain";
import { type MiniToolPlanExact, type MiniToolPlanJobRequest, type MiniToolPlanTarget, type VideoPresentationLedger } from "@breatic/shared";
import { lipsyncChunkSourceWindow, trackingClips, type MiniToolExecutionRegistered, type TrackingClips } from "@breatic/shared/mini-tools";
import { lipsyncFacesFailureLine, lipsyncStepCategory, lipsyncTrackJoinFailureLine } from "@worker/handlers/mini-tool/lipsync-steps.js";
import {
  advanceChunks, advanceClip, advanceContainer, advanceGenerate, advanceRegistered, catalogModel, exactSeconds, providerModel, runsOf, sam3RleLink, type ContainerStep, type ModelStepRun, type StepEnded,
} from "@worker/handlers/mini-tool/model-run-steps.js";
import { prepareModelInput, preparedRequest, type PreparingRun } from "@worker/handlers/mini-tool/prepare-model-input.js";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { chunkInputId, FullLedgerInvalid, modelInputTarget, readJobLedger, segmentTarget, SOURCE_INPUT_ID, windowEntries } from "@worker/handlers/video-presentation-recipes.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { upstreamBody } from "@worker/providers/upstream-body.js";

/** A lip-sync step kind in stage order. */
export type LipSyncStepKind = "prepare" | "prepare:fwd" | "prepare:rev" | LipSyncPersonStep | "composite" | "stitch";
/** One step: a person's (personId set) or a shared one (null). */
export interface LipSyncStep { kind: LipSyncStepKind; personId: string | null }
/** The step a failed person line or shared line is written under (§9.4). */
export type LipSyncLineStep = "prepare" | "track" | "faces" | "clip" | "stem" | "gen" | "composite" | "stitch";
/** What a step reached; the stitch's `done` carries the registered output. */
export type LipSyncStepOutcome =
  | { state: "done"; result?: MiniToolExecutionRegistered }
  | { state: "running" }
  /**
   * A failed step names the step its line is written under: a tracking clip, its join, or a faces job that found no tracked
   * foreground name track (§97 D21-5); `expired` marks a step whose next attempt was due after the deadline (§9.4).
   */
  | { state: "failed"; step: LipSyncLineStep; category: "no_face" | "model_rejected" | "timeout" | "failed"; expired?: true };

type LipSync = Extract<AcceptedMiniToolExecution, { tool: "video.lip-sync" }>;
type Category = Extract<LipSyncStepOutcome, { state: "failed" }>["category"];
/** A step that ended: its object key, or why it failed, under which line step and whether it expired. */
type Ended = { key: string } | { failed: Category; step?: LipSyncLineStep; expired?: true };

/**
 * The expiry mark of a failed step, carried to its outcome.
 * @param ended - The failed step.
 * @param ended.expired - Whether its next attempt was due after the deadline.
 * @returns The mark, or nothing.
 * @throws {never} Never.
 */
function expiryOf(ended: { expired?: true }): { expired?: true } {
  return ended.expired === true ? { expired: true } : {};
}

/** The input ids a recipe binds its objects under, fixed per role and index so a rebuilt request is the same request. */
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
const TRACK_REV = 7;

const genOutputs = z.tuple([z.url()]);

/**
 * The run as the tool-independent step runner reads it.
 * @param execution - The frozen run.
 * @returns Its step-run facts.
 * @throws {never} Never.
 */
function stepRun(execution: LipSync): ModelStepRun {
  return { taskId: execution.taskId, projectId: execution.projectId, sourceKey: execution.sourceKey, container: execution.container,
    ...(execution.retry === undefined ? {} : { retry: { runId: execution.retry.runId } }), log: "lipsync" };
}

/**
 * The tracking clips of the prepared frames [0, e) from the people analysis's one anchor (execution design §10.2).
 * @param execution - The frozen run.
 * @returns The clips.
 * @throws {RangeError} When the anchor lies outside the prepared frames.
 */
function clipsOf(execution: LipSync): TrackingClips {
  return trackingClips({ start: 0, end: execution.layout.preparation.at(-1)!.end }, execution.persons[0]!.anchor.frameIndex);
}

/**
 * A shared step's frozen key (DD §7.1 steps row), read from the plan, never recomputed.
 * @param execution - The frozen run.
 * @param step - The shared step.
 * @returns The key.
 * @throws {Error} When the plan froze no key for the step.
 */
function sharedKeyOf(execution: LipSync, step: `composite:${number}` | "stitch" | "prepare:fwd" | "prepare:rev"): string {
  const frozen = execution.sharedStepKeys[step];
  if (frozen === undefined) throw new Error(`The lip-sync plan froze no key for ${step}`);
  return frozen;
}

/**
 * The prepared video's done request, in this run or the original run.
 * @param execution - The frozen run.
 * @returns The request.
 * @throws {Error} When no preparation is done, or the read fails.
 */
async function preparedOf(execution: LipSync): Promise<MiniToolPlanJobRequest> {
  const single = execution.layout.preparation.length === 1;
  for (const run of await runsOf(stepRun(execution))) {
    const request = await preparedRequest(run, single);
    if (request !== null) return request;
  }
  throw new Error("The lip-sync run has no prepared video");
}

/**
 * Read the frozen full ledger; one that fails its receipt fails the run (§91 D3b-9). Reading it starts no new work, so it is
 * read after the deadline too, and a pickup then still reads the jobs submitted before it (`planReadUntil`).
 * @param execution - The frozen run.
 * @param deadlineAt - The task deadline.
 * @returns The ledger.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when the ledger fails its receipt.
 * @throws {Error} When the read fails in transport.
 */
async function ledgerOf(execution: LipSync, deadlineAt: number): Promise<VideoPresentationLedger> {
  try {
    return await readJobLedger(execution.ledgerReceipts.source, planReadUntil(deadlineAt));
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    logger.error({ err: error, ctx: { taskId: execution.taskId } }, "mini_tool_lipsync_ledger_invalid");
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
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
 * A person of the frozen run and its frozen step keys (DD §7.1 persons row).
 * @param execution - The frozen run.
 * @param personId - The person.
 * @returns The person, its position and its step keys.
 * @throws {Error} When the run names no such person.
 */
function personOf(execution: LipSync, personId: string | null): { index: number; keys: Partial<Record<LipSyncPersonStep, string>> } {
  const index = execution.persons.findIndex((person) => person.personId === personId);
  const person = execution.persons[index];
  if (person === undefined) throw new Error(`The lip-sync run has no person ${personId}`);
  return { index, keys: lipsyncPersonStepKeys(execution.planFingerprint, person, clipsOf(execution)) };
}

/**
 * A step's frozen key.
 * @param keys - The person's keys.
 * @param kind - The step.
 * @returns The key.
 * @throws {Error} When the plan froze no key for the step.
 */
function keyOf(keys: Partial<Record<LipSyncPersonStep, string>>, kind: LipSyncPersonStep): string {
  const key = keys[kind];
  if (key === undefined) throw new Error(`The lip-sync plan froze no key for ${kind}`);
  return key;
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
async function objectOf(execution: LipSync, personId: string, kind: LipSyncPersonStep, userId: string, deadlineAt: number): Promise<string> {
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
async function personContainer(execution: LipSync, stepKey: string, contentType: string, build: ContainerStep["build"], failed: (reason: string) => Ended, deadlineAt: number): Promise<Ended> {
  return await advanceContainer(stepRun(execution), { stepKey, contentType, build, failed }, deadlineAt) as Ended;
}

/**
 * A shared tracking clip's prepared video: the run's preparation for a forward clip starting on frame 0, else the clip's
 * own preparation `prepare:fwd` or `prepare:rev` on the preparation's target in the jobs the plan froze (execution design
 * §10.2).
 * @param execution - The frozen run.
 * @param order - The clip.
 * @param deadlineAt - The task deadline.
 * @returns The clip video's key, or the failure.
 * @throws {StillRunning} While the job runs.
 * @throws {Error} When the run has no such clip, or persistence or IO fails.
 */
async function clipVideo(execution: LipSync, order: "forward" | "reverse", deadlineAt: number): Promise<Ended> {
  const clips = clipsOf(execution);
  const clip = order === "forward" ? clips.forward : clips.reverse;
  if (clip === null) throw new Error(`The lip-sync run tracks no ${order} clip`);
  const prepared = await preparedOf(execution);
  if (order === "forward" && clip.start === 0) return { key: prepared.outputs[0]!.storageKey };
  const { target } = prepared.outputs[0]!.recipe as { target: MiniToolPlanTarget };
  const windows = execution.layout.tracking[order];
  return await advanceClip(stepRun(execution), { stepKey: sharedKeyOf(execution, order === "forward" ? "prepare:fwd" : "prepare:rev"), windows, order,
    ledger: await ledgerOf(execution, deadlineAt), target: { ...target, format: undefined }, failed: () => ({ failed: "failed", step: "prepare" }) }, deadlineAt) as Ended;
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
async function personStep(execution: LipSync, kind: LipSyncPersonStep, personId: string, userId: string, deadlineAt: number): Promise<Ended> {
  const { index, keys } = personOf(execution, personId);
  const person = execution.persons[index]!;
  const storage = await getStorageAdapter();
  switch (kind) {
    case "track:fwd":
    case "track:rev": {
      const order = kind === "track:fwd" ? "forward" : "reverse";
      // The RLE answer is JSON text, which the Worker names by its bytes: signature-less text reads as text/plain.
      const ended = await advanceGenerate(stepRun(execution), { endpoint: providerModel(execution.tracking.model), itemIndex: index * 2 + (order === "forward" ? 0 : 1),
        stepKey: keyOf(keys, kind), contentType: "text/plain", category: (error) => lipsyncStepCategory("track", error, undefined),
        link: sam3RleLink,
        body: async () => {
          const video = await clipVideo(execution, order, deadlineAt);
          if (!("key" in video)) throw new Error(`The lip-sync ${order} clip is not prepared`);
          const { target } = (await preparedOf(execution)).outputs[0]!.recipe as { target: MiniToolPlanTarget };
          const rect = target.displayRect ?? { x: 0, y: 0, width: target.width, height: target.height };
          const box = person.anchorFaceBox;
          // §97 D21-4, execution design §10.2: one box in the clip's pixels on its frame 0, the anchor; the RLE is read, so no
          // mask is applied. The endpoint requires a text prompt; the box selects the person, so the prompt names the class.
          return upstreamBody(catalogModel(execution.tracking.model), { video: storage.publicUrl(video.key), apply_mask: false, box_prompts: [{
            frame_index: 0, object_id: 1,
            x_min: Math.round(rect.x + box.x * rect.width), y_min: Math.round(rect.y + box.y * rect.height),
            x_max: Math.round(rect.x + (box.x + box.width) * rect.width), y_max: Math.round(rect.y + (box.y + box.height) * rect.height) }] }, "person") as Record<string, MiniToolStepJson>;
        } }, userId, deadlineAt);
      return "key" in ended ? ended : { failed: ended.failed as Category, step: "track", ...expiryOf(ended) };
    }
    case "track_join": {
      const clips = clipsOf(execution);
      const tracks = [...(clips.forward === null ? [] : [{ order: "forward" as const, clip: clips.forward, step: "track:fwd" as const, role: TRACK }]),
        ...(clips.reverse === null ? [] : [{ order: "reverse" as const, clip: clips.reverse, step: "track:rev" as const, role: TRACK_REV }])];
      return personContainer(execution, keyOf(keys, "track_join"), "text/plain", async () => {
        const { target } = (await preparedOf(execution)).outputs[0]!.recipe as { target: MiniToolPlanTarget };
        const inputs = await Promise.all(tracks.map(async (track) => ({ inputId: inputOf(track.role, index), storageKey: await objectOf(execution, personId, track.step, userId, deadlineAt) })));
        return { recipe: { kind: "rle_join", inputs: tracks.map((track) => ({ inputId: inputOf(track.role, index), order: track.order, frameCount: track.clip.end - track.clip.start })),
          width: target.width, height: target.height }, inputs };
      }, (reason) => { const line = lipsyncTrackJoinFailureLine(reason); return { failed: line.category as Category, step: line.step }; }, deadlineAt);
    }
    case "faces":
      // The faces table is JSON text, measured by its bytes as text/plain like every analysis table.
      return personContainer(execution, keyOf(keys, "faces"), "text/plain", async () => {
        const [prepared, track] = [(await preparedOf(execution)).outputs[0]!.storageKey, await objectOf(execution, personId, "track_join", userId, deadlineAt)];
        return { recipe: { kind: "lipsync_faces", inputId: PREPARED, track: inputOf(TRACK, 0), profile: getMiniToolsConfig().analyses.people.profile },
          inputs: [{ inputId: PREPARED, storageKey: prepared }, { inputId: inputOf(TRACK, 0), storageKey: track }] };
      }, (reason) => { const line = lipsyncFacesFailureLine(reason); return { failed: line.category as Category, step: line.step }; }, deadlineAt);
    case "clip":
      return personContainer(execution, keyOf(keys, "clip"), "video/mp4", async () => {
        const ledger = await ledgerOf(execution, deadlineAt);
        const inputs = [{ inputId: PREPARED, storageKey: (await preparedOf(execution)).outputs[0]!.storageKey },
          { inputId: inputOf(FACES, 0), storageKey: await objectOf(execution, personId, "faces", userId, deadlineAt) },
          { inputId: inputOf(TRACK, 0), storageKey: await objectOf(execution, personId, "track_join", userId, deadlineAt) }];
        return { recipe: { kind: "lipsync_clip", inputId: PREPARED, faces: inputOf(FACES, 0), track: inputOf(TRACK, 0), cropSize: execution.cropSize,
          timeline: execution.timeline, table: ledger.plan.presentation, encode: execution.container.encode }, inputs };
      }, () => ({ failed: "failed" }), deadlineAt);
    case "stem":
      return personContainer(execution, keyOf(keys, "stem"), "audio/mp4", async () => {
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
      const ended: StepEnded = await advanceGenerate(stepRun(execution), { endpoint: providerModel(execution.generator.modelId), itemIndex: index, stepKey: keyOf(keys, "gen"),
        contentType: "video/mp4", category: (error) => lipsyncStepCategory("gen", error, model?.async_rejection),
        link: (outputs) => { const parsed = genOutputs.safeParse(outputs); return parsed.success ? parsed.data[0] : null; },
        body: async () => upstreamBody(catalogModel(execution.generator.modelId), {
          video: storage.publicUrl(await objectOf(execution, personId, "clip", userId, deadlineAt)),
          audio: storage.publicUrl(await objectOf(execution, personId, "stem", userId, deadlineAt)),
          // §9.3: only a model that accepts it is told to cut the result off at the audio's end.
          ...(execution.generator.providerSyncMode === "cut_off" ? { sync_mode: "cut_off" } : {}),
        }, "") as Record<string, MiniToolStepJson> }, userId, deadlineAt);
      return "key" in ended ? ended : { failed: ended.failed as Category, step: "gen", ...expiryOf(ended) };
    }
    default: throw new Error(`The lip-sync step ${String(kind)} is no person's`);
  }
}

/**
 * The composite chunks over every person's result, faces table and track (§7.17 lipsync_composite row); each decodes only
 * the source frames its result frames show.
 * @param execution - The frozen run.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns Every chunk's output in order, or the failure.
 * @throws {StillRunning} While a chunk runs.
 * @throws {Error} When persistence or IO fails.
 */
async function composite(execution: LipSync, userId: string, deadlineAt: number): Promise<{ keys: string[] } | { failed: Category; expired?: true }> {
  // A transparent original's chunks are VP9 WebM with alpha, as its stitch is (§7.17 lipsync_composite row, §4.3).
  const ledger = await ledgerOf(execution, deadlineAt);
  const target = segmentTarget(ledger, execution.container.encode);
  // The prepared video the tracks and face tables are in, as the preparation encoded it (§5.3 model-input row).
  const { width, height, displayRect } = modelInputTarget(ledger, execution.container.encode);
  // Every chunk advances in each pickup and the composite settles once none still runs (frames-split §5.4 parallel stage).
  const ended = await advanceChunks(stepRun(execution), execution.layout.composite.map((window, chunk): ContainerStep => ({
    stepKey: sharedKeyOf(execution, `composite:${chunk}`), contentType: target.format === "webm-vp9" ? "video/webm" : "video/mp4",
    failed: () => ({ failed: "failed" }), build: async () => {
      const persons = await Promise.all(execution.persons.map(async (person, at) => ({
        ids: { result: inputOf(RESULT, at), faces: inputOf(FACES, at), track: inputOf(TRACK, at) },
        keys: { result: await objectOf(execution, person.personId, "gen", userId, deadlineAt), faces: await objectOf(execution, person.personId, "faces", userId, deadlineAt),
          track: await objectOf(execution, person.personId, "track_join", userId, deadlineAt) } })));
      return { recipe: { kind: "lipsync_composite", inputId: SOURCE_INPUT_ID, window: { start: window.start, end: window.end }, timescale: ledger.plan.presentation.timescale,
        entries: windowEntries(ledger, lipsyncChunkSourceWindow(execution.timeline, ledger.plan.presentation, window)), target,
        timeline: execution.timeline, table: ledger.plan.presentation, persons: persons.map((person) => ({ ...person.ids, cropSize: execution.cropSize })),
        rawDiskBytes: execution.container.rawDiskBytes, feather: execution.faceFeather, prepared: { width, height, displayRect } },
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }, ...persons.flatMap((person) => (["result", "faces", "track"] as const)
        .map((role) => ({ inputId: person.ids[role], storageKey: person.keys[role] })))] };
    } })), deadlineAt);
  return "keys" in ended ? ended : { failed: ended.failed as Category, ...expiryOf(ended) };
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
  if (!("keys" in chunks)) return { state: "failed", step: "stitch", category: chunks.failed, ...expiryOf(chunks) };
  const ledger = await ledgerOf(execution, deadlineAt);
  const target = segmentTarget(ledger, execution.container.encode);
  const done = await advanceRegistered(stepRun(execution), { stepKey: sharedKeyOf(execution, "stitch"), namePrefix: "LIPSYNC", container: target.format === "webm-vp9" ? "webm" : "mp4",
    build: async () => {
      const table = ledger.plan.presentation;
      const step0 = table.runs[0]!.step;
      const stems = await Promise.all(execution.persons.map(async (person) => objectOf(execution, person.personId, "stem", userId, deadlineAt)));
      return { recipe: { kind: "stitch", inputId: SOURCE_INPUT_ID, target,
        chunks: execution.layout.composite.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: exact(BigInt((window.end - window.start) * step0), BigInt(table.timescale)) })),
        audio: { kind: "mix", inputs: stems.map((_key, at) => inputOf(STEM, at)) } },
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: execution.sourceKey }, ...chunks.keys.map((storageKey, chunk) => ({ inputId: chunkInputId(chunk), storageKey })),
        ...stems.map((storageKey, at) => ({ inputId: inputOf(STEM, at), storageKey }))] };
    } }, userId, deadlineAt);
  return "failed" in done ? { state: "failed", step: "stitch", category: "failed", ...expiryOf(done) } : { state: "done", result: done };
}

/**
 * Advance one step.
 * @param execution - The frozen run.
 * @param step - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The step's outcome; a tracking clip the anchor does not need is done at once.
 * @throws {Error} When an earlier step is not done, or persistence, grants, registration or IO fail.
 */
export async function runLipSyncStep(execution: unknown, step: LipSyncStep, userId: string, deadlineAt: number): Promise<LipSyncStepOutcome> {
  const run = execution as LipSync;
  try {
    if (step.kind === "prepare") {
      const preparing: PreparingRun = { taskId: run.taskId, projectId: run.projectId, sourceKey: run.sourceKey, ledgerReceipts: run.ledgerReceipts, presentationRef: run.presentationRef,
        preparation: { ...run.container, chunks: run.layout.preparation } };
      // A retry reuses the preparation of its chain's original run (frames-split §7.11 retry row).
      for (const owner of (await runsOf(stepRun(run))).slice(1)) if (await preparedRequest(owner, run.layout.preparation.length === 1) !== null) return { state: "done" };
      await prepareModelInput(preparing, deadlineAt);
      return { state: "done" };
    }
    if (step.kind === "prepare:fwd" || step.kind === "prepare:rev") {
      const clips = clipsOf(run);
      if ((step.kind === "prepare:fwd" ? clips.forward : clips.reverse) === null) return { state: "done" };
      const ended = await clipVideo(run, step.kind === "prepare:fwd" ? "forward" : "reverse", deadlineAt);
      return "key" in ended ? { state: "done" } : { state: "failed", step: "prepare", category: ended.failed, ...expiryOf(ended) };
    }
    if (step.kind === "composite") {
      const chunks = await composite(run, userId, deadlineAt);
      return "keys" in chunks ? { state: "done" } : { state: "failed", step: "composite", category: chunks.failed, ...expiryOf(chunks) };
    }
    if (step.kind === "stitch") return await stitch(run, userId, deadlineAt);
    if (step.personId === null) throw new Error(`The lip-sync ${step.kind} step belongs to a person`);
    if (step.kind === "track:fwd" || step.kind === "track:rev") {
      const clips = clipsOf(run);
      if ((step.kind === "track:fwd" ? clips.forward : clips.reverse) === null) return { state: "done" };
    }
    const ended = await personStep(run, step.kind, step.personId, userId, deadlineAt);
    return "key" in ended ? { state: "done" } : { state: "failed", step: ended.step ?? (step.kind as LipSyncLineStep), category: ended.failed, ...expiryOf(ended) };
  } catch (error) {
    if (error instanceof StillRunning) return { state: "running" };
    // Only the preparation and the ledger read throw this here; a provider's failure is caught where it is called.
    if (error instanceof UpstreamTaskFailed) {
      logger.error({ err: error, ctx: { taskId: run.taskId, step: step.kind } }, "mini_tool_lipsync_step_failed");
      return { state: "failed", step: step.kind.startsWith("prepare") ? "prepare" : step.kind.startsWith("track") ? "track" : step.kind as LipSyncLineStep, category: "failed" };
    }
    throw error;
  }
}
