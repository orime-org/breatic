// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One task run as its upstream steps (#2156, design §15.1).
 *
 * The steps are written on the task's first run and advanced here only:
 * a pending step is submitted and its prediction id stored before it is asked
 * about, a submitted step is asked about by that id once per pickup, a done
 * step is skipped and what it answered is reused. A step still going hands
 * a still-going answer up, and dispatch decides between the queue and the
 * task's deadline; past the deadline no step is started (inner#1337). What
 * each step answers feeds the next — an upload id, a cloned vocal or voice —
 * and the run is billed across every prediction it made plus what its steps
 * cost outside them.
 */

import { logger } from "@breatic/core";
import type { upstreamCloneRepo, upstreamStepRepo, FullModelEntry } from "@breatic/domain";

import { acquireSemaphore, resolveModel, type ResolvedModel } from "@worker/providers/shared.js";
import { entryOf, FAMILIES, type CatalogModality, type GenerationResult } from "@worker/providers/generate.js";
import { planSteps } from "@worker/providers/plan-steps.js";
import { upstreamBody } from "@worker/providers/upstream-body.js";
import { runPrediction, type PredictionRun } from "@worker/providers/wavespeed.js";
import { queryBilling, UpstreamTaskFailed } from "@worker/providers/http.js";
import { assertBeforeDeadline } from "@worker/providers/still-running.js";

type Step = upstreamStepRepo.UpstreamStep;
type CloneKind = upstreamCloneRepo.UpstreamCloneKind;

/** The task a run belongs to. */
export interface RunTaskContext {
  taskId: string;
  /** The studio whose clone cache the run reads and writes; null leaves the cache alone. */
  studioId: string | null;
  /** The task's two-hour deadline, in epoch milliseconds. */
  deadlineAt: number;
}

/** The storage a run reads and writes; the two domain repositories in production. */
export interface StepDeps {
  steps: Pick<
    typeof upstreamStepRepo,
    "ensureSteps" | "markSubmitted" | "markDone" | "markFailed" | "recordInline"
  >;
  clones: Pick<typeof upstreamCloneRepo, "findClone" | "recordClone" | "retireClone">;
  /**
   * The cache key of a source: its asset's sha256, or null when the url is
   * not an asset of ours.
   */
  sourceKeyOf: (url: string) => Promise<string | null>;
  /** One sentence describing an image, and what writing it cost in USD. */
  describeImage: (url: string) => Promise<{ text: string; costUsd: number }>;
}

/** Kling caps an element's name at 20 characters and its description at 100. */
const ELEMENT_DESCRIPTION_MAX = 100;

/** The Mureka upload each upload step makes: which param it reads and its purpose. */
const UPLOADS = {
  upload_reference: { param: "song", purpose: "reference" },
  upload_melody: { param: "melody", purpose: "melody" },
} as const;

/**
 * How the upstream says a cloned id it once gave is gone, by clone kind —
 * the error text a call with an unknown id returned when probed (voice
 * 2026-09-28, element 2026-09-29). Vocal has no entry: Mureka answers an
 * unknown vocal id with the same words it uses for any refused input, so a
 * refusal cannot tell a gone vocal from a bad lyric.
 */
const GONE: Readonly<Partial<Record<CloneKind, (message: string, id: string) => boolean>>> = {
  // A run reads one voice, and the message does not name it.
  voice: (message) => /Voice ID does not exist/.test(message),
  // A run reads several elements, and the message names the one refused.
  element: (message, id) => /Element id not found: (\S+)/.exec(message)?.[1] === id,
};

/** What the earlier steps of a run answered, for the ones after them. */
interface Carried {
  /** Param name -> the upstream id that replaces its source url. */
  ids: Record<string, string>;
  /** Element ids by the reference image's place in the pool. */
  elementIds: string[];
  /** The cloned voice the speech is read in. */
  voiceId?: string;
  /** Clones this run took from the cache, by kind, so a refusal can retire them. */
  cached: { kind: CloneKind; id: string }[];
  /** Prediction ids to bill. */
  predictions: string[];
  inlineCostUsd: number;
  /** What the run produced, in upstream order. */
  urls?: string[];
}

/**
 * A source param's url.
 * @param params - The run's params.
 * @param param - The param.
 * @returns The url.
 * @throws {Error} when the param carries no url.
 */
function urlOf(params: Readonly<Record<string, unknown>>, param: string): string {
  const value = params[param];
  if (typeof value !== "string" || value === "") throw new Error(`Step needs a source in '${param}'`);
  return value;
}

/**
 * Submit one step's prediction, or ask once about the one it already
 * submitted, under the provider's cap, marking the step failed when the
 * upstream fails it.
 * @param deps - Storage.
 * @param ctx - The task, for the resume context.
 * @param resolved - The model's resolved endpoint.
 * @param step - The step.
 * @param body - The request body; not sent for a step already submitted.
 * @returns The prediction's outputs and id.
 * @throws {UpstreamTaskFailed} when the upstream failed the prediction.
 * @throws {StillRunning} while the prediction is still going.
 * @throws {Error} when the request itself failed; the step stays retryable.
 */
async function predict(
  deps: StepDeps,
  ctx: RunTaskContext,
  resolved: ResolvedModel,
  step: Step,
  body: Record<string, unknown>,
): Promise<PredictionRun> {
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);
  try {
    return await runPrediction(resolved, step.endpoint, body, {
      storedTaskId: step.predictionId,
      persistTaskId: (id: string): Promise<void> => deps.steps.markSubmitted(step.id, id),
      externalTaskId: `breatic-${ctx.taskId}-${step.position}`,
    });
  } catch (err) {
    if (err instanceof UpstreamTaskFailed) await deps.steps.markFailed(step.id, err.upstreamError);
    throw err;
  } finally {
    release();
  }
}

/**
 * A field of the first structured output.
 * @param run - The prediction.
 * @param field - The field.
 * @returns Its value.
 * @throws {Error} when the output carries no such string.
 */
function outputField(run: PredictionRun, field: string): string {
  const first = run.outputs[0];
  const value = typeof first === "object" && first !== null ? (first as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || value === "") throw new Error(`No ${field} in the upstream answer`);
  return value;
}

/**
 * A clone id: from the cache when this source was cloned before, otherwise
 * from the upstream, recorded for the next run.
 * @param deps - Storage.
 * @param ctx - The task.
 * @param kind - What is cloned.
 * @param sourceUrl - The source.
 * @param keySuffix - Added to the source's hash in the cache key (an element's name).
 * @param step - The clone step; one already submitted resumes its own prediction.
 * @param clone - Runs the clone upstream and answers the id.
 * @returns The id and whether it came from the cache.
 */
async function cloneOnce(
  deps: StepDeps,
  ctx: RunTaskContext,
  kind: CloneKind,
  sourceUrl: string,
  keySuffix: string,
  step: Step,
  clone: () => Promise<string>,
): Promise<{ id: string; cached: boolean }> {
  const sha = ctx.studioId === null ? null : await deps.sourceKeyOf(sourceUrl);
  const key = sha === null ? null : `${sha}${keySuffix}`;
  if (step.status === "pending" && ctx.studioId !== null && key !== null) {
    const hit = await deps.clones.findClone(ctx.studioId, kind, key);
    if (hit !== null) return { id: hit, cached: true };
  }
  const id = await clone();
  if (ctx.studioId !== null && key !== null) await deps.clones.recordClone(ctx.studioId, kind, key, id);
  return { id, cached: false };
}

/**
 * The voice id the clone step registers upstream: starts with a letter,
 * holds letters and numbers, unique per task.
 * @param taskId - The task.
 * @returns The id.
 */
function customVoiceId(taskId: string): string {
  return `Breatic${taskId.replace(/-/g, "")}`;
}

/**
 * The request body a generate step submits.
 * @param entry - The model.
 * @param prompt - The reader's prompt.
 * @param params - The run's params.
 * @param carried - What earlier steps answered.
 * @returns The body.
 * @throws {Error} when the model's family fails to prepare the prompt.
 */
async function generateBody(
  entry: FullModelEntry,
  prompt: string,
  params: Readonly<Record<string, unknown>>,
  carried: Carried,
): Promise<Record<string, unknown>> {
  const family = FAMILIES.get(entry.name);
  const withIds: Record<string, unknown> = { ...params, ...carried.ids };
  if (carried.elementIds.length > 0) withIds.elements = carried.elementIds.map((id) => ({ element_id: id }));
  const prepared = family ? await family.prepare(prompt, withIds) : { prompt, fields: {} };
  return { ...upstreamBody(entry, withIds, prepared.prompt, family?.CONSUMES), ...prepared.fields };
}

/**
 * Run one pending or submitted step and answer what it produced.
 * @param deps - Storage.
 * @param ctx - The task.
 * @param resolved - The model's resolved endpoint.
 * @param entry - The model.
 * @param step - The step.
 * @param prompt - The reader's prompt.
 * @param params - The run's params.
 * @param carried - What earlier steps answered.
 * @returns What to store as the step's output.
 * @throws {Error} when the step cannot run or the upstream answers nothing usable.
 */
async function runStep(
  deps: StepDeps,
  ctx: RunTaskContext,
  resolved: ResolvedModel,
  entry: FullModelEntry,
  step: Step,
  prompt: string,
  params: Readonly<Record<string, unknown>>,
  carried: Carried,
): Promise<Record<string, unknown>> {
  switch (step.kind) {
    case "upload_reference":
    case "upload_melody": {
      const { param, purpose } = UPLOADS[step.kind];
      const run = await predict(deps, ctx, resolved, step, { audio: urlOf(params, param), purpose });
      return { param, id: outputField(run, `${purpose}_id`), prediction: run.taskId };
    }
    case "vocal": {
      let prediction = "";
      const { id, cached } = await cloneOnce(deps, ctx, "vocal", urlOf(params, "vocal"), "", step, async () => {
        const run = await predict(deps, ctx, resolved, step, { audio: urlOf(params, "vocal") });
        prediction = run.taskId;
        return outputField(run, "vocal_id");
      });
      return { param: "vocal", id, cached, prediction };
    }
    case "voice": {
      let prediction = "";
      const source = urlOf(params, entry.reused_by ?? "");
      const { id, cached } = await cloneOnce(deps, ctx, "voice", source, "", step, async () => {
        const voiceId = customVoiceId(ctx.taskId);
        const run = await predict(deps, ctx, resolved, step, {
          ...upstreamBody(entry, params, ""),
          custom_voice_id: voiceId,
        });
        prediction = run.taskId;
        return voiceId;
      });
      return { voiceId: id, cached, prediction };
    }
    case "speak": {
      if (carried.voiceId === undefined) throw new Error("No cloned voice to speak with");
      const run = await predict(deps, ctx, resolved, step, { text: prompt, voice_id: carried.voiceId });
      return { urls: [outputUrls(run)[0]!], prediction: run.taskId };
    }
    case "generate": {
      // A submitted step is only asked about, so its body is not built: for
      // some families building it is a paid LLM call.
      const body = step.predictionId === null ? await generateBody(entry, prompt, params, carried) : {};
      const run = await predict(deps, ctx, resolved, step, body);
      return { urls: outputUrls(run), prediction: run.taskId };
    }
    case "element": {
      const index = step.itemIndex ?? 0;
      const images = params.elements;
      const image = Array.isArray(images) ? images[index] : undefined;
      if (typeof image !== "string" || image === "") throw new Error(`No reference image at place ${index + 1}`);
      // The prompt names elements by their place in the pool, the same way
      // the panel writes a mention of that image.
      const name = `Element ${index + 1}`;
      let prediction = "";
      const { id, cached } = await cloneOnce(deps, ctx, "element", image, `:${name}`, step, async () => {
        let description = step.output.description;
        if (typeof description !== "string") {
          const described = await deps.describeImage(image);
          description = described.text.slice(0, ELEMENT_DESCRIPTION_MAX);
          await deps.steps.recordInline(step.id, { description }, described.costUsd);
          step.inlineCostUsd += described.costUsd;
        }
        const run = await predict(deps, ctx, resolved, step, {
          name,
          description,
          image,
          element_refer_list: [image],
        });
        prediction = run.taskId;
        return outputField(run, "element_id");
      });
      return { index, elementId: id, cached, prediction };
    }
    case "container_job":
      // A container run is driven by its own executor, never by a catalog plan.
      throw new Error("A container job is not a catalog step");
  }
}

/**
 * Every output as a url, in upstream order.
 * @param run - The prediction.
 * @returns The urls, at least one.
 * @throws {Error} when the prediction answered no output, or one that is not a url.
 */
function outputUrls(run: PredictionRun): string[] {
  const urls = run.outputs;
  if (urls.length === 0 || !urls.every((url): url is string => typeof url === "string" && url !== "")) {
    throw new Error("No output URL after WaveSpeed polling");
  }
  return [...urls];
}

/**
 * Fold one step's output into what the later steps read.
 * @param carried - Accumulated answers, updated in place.
 * @param step - The step.
 * @param output - What it answered.
 */
function carry(carried: Carried, step: Step, output: Record<string, unknown>): void {
  if (typeof output.prediction === "string" && output.prediction !== "") carried.predictions.push(output.prediction);
  carried.inlineCostUsd += step.inlineCostUsd;
  if (typeof output.param === "string" && typeof output.id === "string") carried.ids[output.param] = output.id;
  if (typeof output.voiceId === "string") carried.voiceId = output.voiceId;
  if (typeof output.index === "number" && typeof output.elementId === "string") {
    carried.elementIds[output.index] = output.elementId;
  }
  // A step finished before outputs were kept as a list stored one url.
  if (Array.isArray(output.urls)) carried.urls = output.urls as string[];
  else if (typeof output.url === "string") carried.urls = [output.url];
  if (output.cached === true) {
    const id = (output.id ?? output.voiceId ?? output.elementId) as string;
    const kind: CloneKind = step.kind === "voice" ? "voice" : step.kind === "element" ? "element" : "vocal";
    carried.cached.push({ kind, id });
  }
}

/**
 * Retire the cached clones the upstream said are gone.
 * @param deps - Storage.
 * @param ctx - The task.
 * @param carried - What the run used.
 * @param err - The failure.
 */
async function retireGone(deps: StepDeps, ctx: RunTaskContext, carried: Carried, err: unknown): Promise<void> {
  if (!(err instanceof UpstreamTaskFailed) || ctx.studioId === null) return;
  for (const { kind, id } of carried.cached) {
    if (GONE[kind]?.(err.upstreamError, id) === true) {
      await deps.clones.retireClone(ctx.studioId, kind, id);
      logger.warn({ taskId: ctx.taskId, kind, upstreamId: id }, "upstream_clone_retired");
    }
  }
}

/**
 * Run a task's upstream steps and bill them.
 * @param deps - Storage.
 * @param ctx - The task.
 * @param modality - The model's modality.
 * @param prompt - The reader's prompt.
 * @param modelName - Model name (required).
 * @param params - Validated params.
 * @param outputCount - How many outputs the caller writes to nodes: 1 for a
 *   canvas generation, the tool's declared outputs for a mini-tool.
 * @returns The outputs, the model and the billed cost in USD.
 * @throws {UpstreamTaskFailed} when the upstream failed a step.
 * @throws {StillRunning} while a step's prediction is still going.
 * @throws {TaskDeadlinePassed} when the deadline has passed before a step is started.
 * @throws {Error} when a step already failed, cannot run, or the run answered no output.
 */
export async function runCatalogTask(
  deps: StepDeps,
  ctx: RunTaskContext,
  modality: CatalogModality,
  prompt: string,
  modelName: string | undefined,
  params: Readonly<Record<string, unknown>>,
  outputCount: number,
): Promise<GenerationResult> {
  const resolved = resolveModel(modality, modelName);
  const entry = entryOf(modality, resolved.modelName);
  const steps = await deps.steps.ensureSteps(ctx.taskId, planSteps(entry, params));
  const carried: Carried = { ids: {}, elementIds: [], cached: [], predictions: [], inlineCostUsd: 0 };

  for (const step of steps) {
    if (step.status === "failed") {
      const reason = step.output.error;
      throw new UpstreamTaskFailed(resolved.providerName, typeof reason === "string" ? reason : `step ${step.kind} failed`);
    }
    let output = step.output;
    if (step.status !== "done") {
      // Past the deadline nothing new is started; a step already submitted
      // is still asked once, and keeps a result the upstream had ready.
      if (step.predictionId === null) assertBeforeDeadline(ctx.deadlineAt);
      try {
        output = await runStep(deps, ctx, resolved, entry, step, prompt, params, carried);
      } catch (err) {
        await retireGone(deps, ctx, carried, err);
        throw err;
      }
      await deps.steps.markDone(step.id, output);
    }
    carry(carried, step, output);
  }

  if (carried.urls === undefined) throw new Error("No output URL after WaveSpeed polling");
  let cost = carried.inlineCostUsd;
  for (const prediction of carried.predictions) cost += await queryBilling(resolved, prediction);
  const outputs = carried.urls.slice(0, outputCount).map((url) => ({ url }));
  return { outputs, model: resolved.modelName, cost };
}
