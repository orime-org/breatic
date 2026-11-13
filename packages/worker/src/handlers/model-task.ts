// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A model run, a canvas generation or a model mini-tool, through provider (inner#1743).
 *
 * The task's params are made into the run provider takes: the prompt lifted out before the rest is validated
 * (#1967), the run laid out in our param names (`paramsToSend`), on the route the estimate used. Nano Banana 2's
 * prompt is rewritten when the run is opened, never on a later pickup. The run itself goes ticket by ticket
 * (`runMedia`), against the task row, the studio's clone cache and what a task from before provider left behind.
 */

import { getStorageAdapter, getUnderstandConfig, getWorkerConfig } from "@breatic/core";
import { assetRepo, assetService, provider, taskRepo, taskService, upstreamCloneRepo, upstreamStepRepo } from "@breatic/domain";
import { paramsToSend, routeSchema, type SendableModel } from "@breatic/shared";
import type { Cost, Route } from "@breatic/provider";
import { createMediaRunner, type LegacyRows, type LegacyStep, type MediaInput, type MediaRunner } from "@breatic/provider/media";

import { runMedia, type MediaRunDeps, type MediaRunDone } from "@worker/handlers/media-run.js";
import { entryOf, validateModelParams, type CatalogModality } from "@worker/handlers/model-params.js";
import { takePromptAndValidate } from "@worker/handlers/prompt-params.js";
import { rewrittenPrompt, REWRITTEN_MODELS } from "@worker/handlers/prompt-rewrite.js";
import { withUnderstandSlot } from "@worker/handlers/understand-slots.js";

/** A model run a task asks for. */
export interface ModelTask {
  taskId: string;
  modality: CatalogModality;
  model: string;
  /** The task's params as submitted, the prompt and the route among them. */
  params: Record<string, unknown>;
  /** The project, whose studio keys the clone cache; none leaves the cache alone. */
  projectId: string | undefined;
  /** How many outputs the task writes: 1 for a canvas generation, the tool's outputs for a mini-tool. */
  outputCount: number;
  /** The task's deadline, in epoch milliseconds. */
  deadlineAt: number;
  /** Whether no retry follows this attempt. */
  lastAttempt: boolean;
}

/** Fields a task carries in its params that are not the model's. */
const TASK_FIELDS = ["node_ids", "project_id", "model", "route"] as const;

let runner: MediaRunner | undefined;

/**
 * This process's media runner, built once: it holds each upstream's concurrency.
 * @returns The runner.
 */
export function mediaRunner(): MediaRunner {
  runner ??= createMediaRunner(provider(), {
    mediaLimits: { maxMediaBytes: getUnderstandConfig().max_media_bytes },
    pollIntervalMs: getWorkerConfig().poll_interval,
  });
  return runner;
}

/**
 * The asset behind one of our storage urls, whichever studio registered it (a node pasted from another studio keeps
 * the url): its sha256 and its length.
 * @param url - A source url.
 * @returns Its hash and length, or null for a url that is not ours or that no live asset is stored under.
 */
async function sourceOf(url: string): Promise<{ sha256: string; durationSeconds: number | null } | null> {
  const key = (await getStorageAdapter()).keyFromUrl(url);
  const asset = key === null ? null : await assetRepo.findLiveByStorageKey(key);
  return asset === null ? null : { sha256: asset.contentHash, durationSeconds: asset.durationSeconds };
}

/**
 * What a task from before provider left behind: the vendor task id it stored, and its upstream steps.
 * @param taskId - The task.
 * @returns Its rows, empty for a task provider opened.
 */
async function legacyRows(taskId: string): Promise<LegacyRows> {
  const task = await taskService.getByIdInternal(taskId);
  const steps: LegacyStep[] = [];
  for (const step of await upstreamStepRepo.listSteps(taskId)) {
    // A container job is driven by its own executor, never by a model run.
    if (step.kind === "container_job") continue;
    const { id: _id, ...rest } = step;
    steps.push({ ...rest, kind: step.kind });
  }
  return { providerTaskId: task?.providerTaskId ?? null, steps };
}

/**
 * Whether a task from before provider already sent its generation: its prompt then went out as it was.
 * @param legacy - What the task left behind.
 * @returns True when an upstream holds the generation.
 */
function generationSent(legacy: LegacyRows): boolean {
  if ((legacy.providerTaskId ?? null) !== null) return true;
  return (legacy.steps ?? []).some((step) => step.kind === "generate" && step.predictionId !== null);
}

/**
 * Run a model task through provider, one pickup at a time.
 * @param task - The task.
 * @returns What the run made, its costs and the upstream that served it.
 * @throws {StillRunning} When the run is running upstream, or no reading place is free for a description.
 * @throws {MediaRunFailed} When provider answered the run failed.
 * @throws {DeadlinePassed} When the deadline passed before a step could be sent, or cut a call.
 * @throws {Error} When the model is not in the catalog, a text param is longer than its cap or shorter than its least
 *   length once cleaned, or the task's route is not one `routeSchema` accepts.
 */
export async function runModelTask(task: ModelTask): Promise<MediaRunDone> {
  const own = { ...task.params };
  for (const field of TASK_FIELDS) delete own[field];
  const [prompt, , validated] = takePromptAndValidate(own, task.model, (model, params) => validateModelParams(task.modality, model, params));
  const declared = entryOf(task.modality, task.model);
  const entry = declared as unknown as SendableModel;
  const route: Route = task.params.route === undefined ? { mode: "default" } : routeSchema.parse(task.params.route);
  const studioId = task.projectId === undefined ? null : await assetService.resolveOwnerStudioId(task.projectId);

  /**
   * The run as provider takes it.
   * @param legacy - What the task left behind.
   * @returns Its input.
   */
  const input = async (legacy: LegacyRows): Promise<MediaInput> => {
    const sent = paramsToSend(entry, validated, prompt);
    if (!REWRITTEN_MODELS.has(entry.name) || generationSent(legacy)) return sent;
    return { ...sent, prompt: await rewrittenPrompt(prompt, validated, sent.prompt, task.deadlineAt) };
  };

  const deps: MediaRunDeps = {
    runner: mediaRunner(),
    tickets: taskRepo,
    clones: upstreamCloneRepo,
    sourceOf,
    legacy: legacyRows,
    readingPlace: withUnderstandSlot,
    pollIntervalMs: getWorkerConfig().poll_interval,
  };
  return runMedia({
    taskId: task.taskId,
    studioId,
    model: entry.name,
    displayName: declared.display_name ?? declared.name,
    input,
    route,
    deadlineAt: task.deadlineAt,
    outputCount: task.outputCount,
    lastAttempt: task.lastAttempt,
  }, deps);
}

/**
 * What a task's run cost when the task ends on a throw: what its ticket holds and a lookup for every step an upstream
 * accepted. A task holding no ticket cost nothing here.
 * @param taskId - The task.
 * @returns The costs.
 */
export async function abandonedCosts(taskId: string): Promise<Cost[]> {
  const { ticket } = await taskRepo.getProviderTicket(taskId);
  return ticket === null ? [] : mediaRunner().abandon(ticket).costs;
}
