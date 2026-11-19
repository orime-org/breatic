// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A model run, a canvas generation or a model mini-tool, through provider (inner#1743).
 *
 * The task's params are made into the run provider takes: the prompt lifted out before the rest is validated
 * (#1967), the run laid out in our param names (`paramsToSend`), on the route the estimate used. Nano Banana 2's
 * prompt is rewritten when the run is opened, never on a later pickup. The run itself goes ticket by ticket
 * (`runMedia`), against the task row, the studio's clone cache and what a task from before provider left behind.
 * Each pickup reads the account keys the task runs on by the key row ids it holds (inner#1953), never storing a key.
 */

import { getStorageAdapter, getUnderstandConfig, getWorkerConfig, logger } from "@breatic/core";
import { assetRepo, assetService, createUsageRecorder, keysById, provider, taskRepo, taskService, upstreamCloneRepo, upstreamStepRepo, watchModelCalls } from "@breatic/domain";
import { paramsToSend, routeSchema, type SendableModel } from "@breatic/shared";
import { accountKeyFailureIn, type Cost, type KeySet, type Route } from "@breatic/provider";
import { createMediaRunner, type LegacyRows, type LegacyStep, type MediaInput, type MediaRunner } from "@breatic/provider/media";

import { runMedia, type MediaRunDeps, type MediaRunDone } from "@worker/handlers/media-run.js";
import { entryOf, validateModelParams, type CatalogModality } from "@worker/handlers/model-params.js";
import { takePromptAndValidate } from "@worker/handlers/prompt-params.js";
import { REWRITE_MODEL, rewrittenPrompt, REWRITTEN_MODELS, type RewriteBilled } from "@worker/handlers/prompt-rewrite.js";
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
  /** Who started the task, whose usage rows a call inside it is recorded under. */
  actorUserId: string;
  /** The account key row the media runs on (`tasks.key_id`); null or absent on our keys. */
  keyId?: string | null;
  /** The account key row of a language-model step inside the run (`tasks.llm_key_id`); null or absent on ours. */
  llmKeyId?: string | null;
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
 * @throws {AccountKeyFailure} `account_key_missing` when a key row the task holds was replaced or deleted; nothing is
 *   sent, and our keys are never used instead.
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
  // Read before anything is sent: a media key row replaced or deleted since submit ends the run here. The language-model
  // row serves only the prompt rewrite and the description step, so one gone ends the run only when a step asks for it.
  const media = task.keyId == null ? null : await keysById(task.keyId);
  const llm = task.llmKeyId == null ? null : await keysWhenAsked(task.llmKeyId);

  /**
   * The run as provider takes it.
   * @param legacy - What the task left behind.
   * @returns Its input.
   */
  const input = async (legacy: LegacyRows): Promise<MediaInput> => {
    const sent = paramsToSend(entry, validated, prompt);
    if (!REWRITTEN_MODELS.has(entry.name) || generationSent(legacy)) return sent;
    const { llmKeyId } = task;
    const account = llm === null || llmKeyId == null ? undefined : { keys: llm.keys, record: (billed: RewriteBilled) => recordRewrite(task, llmKeyId, billed) };
    const rewrite = await rewrittenPrompt(prompt, validated, sent.prompt, task.deadlineAt, account);
    return { ...sent, prompt: rewrite.prompt };
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
    ...(media !== null && { keys: media.keys }),
    ...(llm !== null && { llmKeys: llm.keys }),
    // A clone lives on the upstream account the key belongs to, so the key row names it: a replaced key starts afresh.
    cloneOwner: task.keyId ?? "deployment",
  }, deps);
}

/**
 * Record a prompt rewrite that ran on the payer's OpenRouter key (inner#1953): a usage row under that key row at 0
 * credits, written when the rewrite answers, since the run it opens may finish on a later pickup. A row that fails to
 * land is logged; the run goes on.
 * @param task - The task.
 * @param keyId - The language-model key row it ran on.
 * @param billed - The finished call and the answers it was billed for and could not finish.
 * @returns Nothing.
 */
async function recordRewrite(task: ModelTask, keyId: string, billed: RewriteBilled): Promise<void> {
  try {
    const usage = createUsageRecorder({
      operationKey: `task:${task.taskId}`,
      feature: "canvas_generation",
      actorUserId: task.actorUserId,
      projectId: task.projectId ?? null,
      keyId,
      onMissingCost: (row) => logger.error({ row, taskId: task.taskId }, "agent_usage_cost_missing"),
    });
    const watch = watchModelCalls(usage, { model: REWRITE_MODEL, description: "Task: prompt rewrite", keyId }, billed.pending);
    if (billed.ended !== undefined) watch.callEnded(billed.ended);
    await watch.handOff();
    await usage.settle();
  } catch (err) {
    logger.error({ err, taskId: task.taskId }, "prompt_rewrite_usage_failed");
  }
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

/**
 * The keys of an account key row, read now; a row replaced or deleted since submit gives a set whose every key read
 * fails as that row's `account_key_missing`, so only a step that asks for the key ends the run.
 * @param keyId - The row.
 * @returns The keys.
 * @throws {Error} Whatever reading the row throws other than `account_key_missing`.
 */
async function keysWhenAsked(keyId: string): Promise<{ keys: KeySet }> {
  try {
    return (await keysById(keyId))!;
  } catch (err) {
    if (accountKeyFailureIn(err)?.kind !== "account_key_missing") throw err;
    return { keys: { owner: "account", keyOf: () => { throw err; } } };
  }
}
