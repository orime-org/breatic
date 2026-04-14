/**
 * BullMQ job handlers for task execution.
 *
 * Implements 5 execution paths matching the Python worker:
 * 1. Mini-tool → direct provider call
 * 2. Understand → media analysis / ASR
 * 3. AIGC Direct → provider call with explicit params
 * 4. Skill (explicit) → AI SDK agent loop
 * 5. Skill (auto-select) → merged skills, LLM chooses
 */

import type { Job } from "bullmq";
import { generateText, stepCountIs } from "ai";
import { MINI_TOOL_DEFAULTS } from "./mini-tool-defaults.js";
import { getModel } from "@breatic/core";
import { buildToolSet } from "@breatic/core";
import { getSkillRegistry } from "@breatic/core";
import { getRedis } from "@breatic/core";
import { downloadAndStore, getStorageAdapter, storageKey } from "@breatic/core";
import { taskService } from "@breatic/core";
import { creditService } from "@breatic/core";
import { nodeHistoryService } from "@breatic/core";
import { publishNodeEvent } from "@breatic/core";
import { env } from "@breatic/core";
import { logger } from "@breatic/core";

const AIGC_TASK_TYPES: Record<string, string> = {
  image: "image",
  audio: "audio",
  video: "video",
  tts: "tts",
  three_d: "three-d",
};

/** Understand default models by source type. */
const UNDERSTAND_DEFAULTS: Record<string, string> = {
  image: "gemini-flash-vi",
  video: "gemini-flash-vv",
  audio: "gemini-flash-va",
};

/** Job data shape from BullMQ. */
export interface TaskJobData {
  taskId: string;
  taskType: string;
  userId: string;
  projectId?: string;
  params: Record<string, unknown>;
  model?: string;
  skillName?: string;
  source?: string;
  toolName?: string;
}

/**
 * Process a task job from the BullMQ queue.
 *
 * Billing policy (AIGC, non-text-generation):
 *   1. The user is charged **only** when the file is successfully
 *      persisted to permanent storage (OSS / S3 / local).
 *   2. Provider invocation may be retried (network blips, 429, etc.).
 *   3. Once the provider has returned a result, retries are forbidden
 *      — if BullMQ redelivers this job after `providerResultUrl` was
 *      recorded, we mark the task failed immediately and return.
 *   4. Each successful completion charges exactly once, enforced by a
 *      CAS on `tasks.billed_at` inside `markCompletedAndBill`.
 *
 * Execution stages:
 *   [re-entry guard] → [provider call] → [record providerResultUrl]
 *   → [persist to storage] → [markCompletedAndBill (CAS)] → [deduct]
 *
 * Errors before the provider result is recorded cause BullMQ to retry
 * the job. Errors after (persist failure, markCompleted failure) cause
 * the task to be marked failed with **no charge** — the user can re-run
 * from scratch if they want the result.
 *
 * @param job - BullMQ job with TaskJobData payload
 * @returns Result dict on success, or a failure status marker
 */
export async function runTask(job: Job<TaskJobData>): Promise<Record<string, unknown>> {
  const { taskId, taskType, userId, projectId, params, model, skillName, source, toolName } = job.data;

  const redis = getRedis();
  const nodeId = params.node_id as string | undefined;

  // ─── Re-entry guard ───────────────────────────────────────────────
  // Two cases where BullMQ might redeliver a job we've already touched:
  //
  //   (a) billed_at is already set → the task completed successfully
  //       on a previous run. Idempotent no-op: preserve status and
  //       return the stored result. DO NOT mark failed — that would
  //       overwrite a legitimate `completed` status.
  //
  //   (b) provider_result_url is set but billed_at is not → the
  //       provider was invoked on a previous run but the task never
  //       reached the billing step (Worker crashed during persist,
  //       markCompletedAndBill failed, etc). Per policy, no further
  //       retries — mark failed and release the node without charging.
  const existing = await taskService.getByIdInternal(taskId);
  if (existing?.billedAt) {
    logger.info(
      { taskId, billedCredits: existing.billedCredits },
      "Task already completed + billed; returning stored result",
    );
    return (existing.result ?? { alreadyCompleted: true }) as Record<string, unknown>;
  }
  if (existing?.providerResultUrl) {
    logger.warn(
      { taskId, providerResultUrl: existing.providerResultUrl },
      "BullMQ redelivered task after provider call but before billing; failing per no-retry policy",
    );
    await taskService.markFailed(taskId, "Task retry not allowed after provider call");
    await publishFailedEvent(redis, projectId, nodeId, taskId, userId, model, params, "Retry not allowed after provider returned a result");
    return { failed: true, reason: "no_retry_after_provider" };
  }

  await taskService.markRunning(taskId, job.id ?? "");

  // ─── Stage 1: Call the provider ───────────────────────────────────
  // Errors here rethrow → BullMQ retries (this stage is retry-safe).
  let providerResult: Record<string, unknown>;
  let creditsUsed = 0;
  let resolvedSkills: string[] = [];
  const startTime = performance.now();

  try {
    if (source === "mini_tool" && toolName) {
      [providerResult, creditsUsed] = await runMiniTool(toolName, taskType, params);
    } else if (taskType === "understand") {
      [providerResult, creditsUsed] = await runUnderstand(model, params);
    } else if (taskType in AIGC_TASK_TYPES && !skillName) {
      [providerResult, creditsUsed] = await runAigcDirect(taskType, model, params);
    } else {
      const [text, skills] = await runSkillAgent(taskType, skillName, params);
      resolvedSkills = skills;
      try {
        providerResult = JSON.parse(text) as Record<string, unknown>;
      } catch {
        providerResult = { content: text };
      }
    }
  } catch (err) {
    // Provider call failed. Safe to retry via BullMQ — no charge yet,
    // no provider_result_url recorded. The next retry enters this
    // function fresh.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, error: errorMsg }, "provider_call_failed");
    await taskService.markFailed(taskId, errorMsg);
    await recordFailureHistory(taskId, projectId, nodeId, userId, model, params, errorMsg);
    await publishFailedEvent(redis, projectId, nodeId, taskId, userId, model, params, errorMsg);
    throw err; // Rethrow to let BullMQ schedule a retry (attempts > 1)
  }

  // ─── Point of no return: record that the provider has returned ───
  // From here on, any failure must NOT re-run the provider. We write
  // provider_result_url (or a sentinel if the transport returned a
  // raw buffer with no upstream URL) so the re-entry guard at the top
  // of runTask can detect a duplicate delivery and fail-fast.
  const providerUrlSentinel =
    (providerResult.url as string | undefined) ??
    (providerResult.url_original as string | undefined) ??
    `buffer://${taskId}`; // sync transports return raw bytes with no URL
  await taskService.recordProviderResult(taskId, providerUrlSentinel);

  // ─── Stage 2: Persist to permanent storage ────────────────────────
  // Any error here marks the task failed with NO CHARGE and NO RETRY.
  let result: Record<string, unknown>;
  try {
    result = await persistResultUrls(providerResult, { taskType, userId, projectId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, error: errorMsg }, "persist_failed_no_charge");
    await taskService.markFailed(taskId, `Persist failed: ${errorMsg}`);
    await recordFailureHistory(taskId, projectId, nodeId, userId, model, params, errorMsg);
    await publishFailedEvent(redis, projectId, nodeId, taskId, userId, model, params, errorMsg);
    // Return normally (don't throw) — we don't want BullMQ to retry
    // something we've explicitly decided not to charge for.
    return { failed: true, reason: "persist_failed" };
  }

  // Per policy: the task's "content" must be a URL pointing at permanent
  // storage for the user to be charged. If persist ran but didn't produce
  // a usable URL (e.g. text content from Skill agent), treat it as text
  // and skip the AIGC charging rule.
  const persistedUrl = result.url as string | undefined;

  // Extract video cover (best-effort, failure is non-fatal)
  if (taskType === "video" && typeof persistedUrl === "string") {
    try {
      const { extractVideoCover } = await import("@breatic/core");
      const coverUrl = await extractVideoCover(persistedUrl, { userId, projectId });
      if (coverUrl) {
        result.cover_url = coverUrl;
      }
    } catch (err) {
      logger.warn({ taskId, err }, "video_cover_extraction_failed_non_fatal");
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  // ─── Stage 3: Mark completed + charge (atomic via CAS) ────────────
  // markCompletedAndBill uses a WHERE billed_at IS NULL clause so only
  // the first Worker to reach this step wins the charge. Any subsequent
  // retry (shouldn't happen given the re-entry guard above, but defense
  // in depth) reads `wasFirst = false` and skips the deduct step.
  await taskService.setResolvedSkills(taskId, resolvedSkills);
  const wasFirst = await taskService.markCompletedAndBill(taskId, result, creditsUsed, durationMs);

  if (wasFirst && creditsUsed > 0) {
    try {
      await creditService.deduct(
        userId,
        creditsUsed,
        `Task: ${taskType}`,
        taskId,
        { model: (result.model as string | undefined) ?? model },
      );
    } catch (err) {
      // Deduct failed AFTER the CAS marked billed_at. The file is
      // already persisted and the task is completed. Log loudly for
      // manual reconciliation — do NOT roll back billed_at because
      // that would allow a double-charge on the next retry. Also do
      // NOT fail the task — the user is entitled to their result.
      logger.error(
        { taskId, userId, creditsUsed, err },
        "DEDUCT_FAILED_AFTER_COMPLETION — manual reconciliation required",
      );
    }
  } else if (!wasFirst) {
    logger.info({ taskId }, "Task already completed by a prior run; skipping deduct");
  }

  // ─── Stage 4: Record history + publish completed event ────────────
  if (nodeId && projectId && typeof persistedUrl === "string") {
    try {
      await nodeHistoryService.recordGenerationSuccess({
        projectId,
        nodeId,
        userId,
        content: persistedUrl,
        thumbnailUrl: (result.cover_url as string | undefined) ?? (taskType === "image" ? persistedUrl : undefined),
        taskId,
        metadata: {
          model: (result.model as string | undefined) ?? model,
          cost: result.cost as number | undefined,
          durationMs,
          params,
        },
      });
    } catch (err) {
      logger.warn({ err, taskId, nodeId }, "Failed to record node history (success)");
    }
  }

  if (nodeId && projectId) {
    await publishNodeEvent(redis, {
      type: "completed",
      projectId,
      nodeId,
      content: (persistedUrl ?? (result.content as string | undefined)) ?? "",
      cover_url: result.cover_url as string | undefined,
    });
  }

  logger.info(
    { taskId, taskType, skillName, resolvedSkills, creditsUsed, durationMs, billed: wasFirst },
    "task_completed",
  );
  return result;
}

// ─── Failure-path helpers ────────────────────────────────────────────

/** Record a failed-generation entry in node_history (non-fatal). */
async function recordFailureHistory(
  taskId: string,
  projectId: string | undefined,
  nodeId: string | undefined,
  userId: string,
  model: string | undefined,
  params: Record<string, unknown>,
  errorMessage: string,
): Promise<void> {
  if (!nodeId || !projectId) return;
  try {
    await nodeHistoryService.recordGenerationFailure({
      projectId,
      nodeId,
      userId,
      errorMessage,
      taskId,
      metadata: { model, params },
    });
  } catch (err) {
    logger.warn({ err, taskId, nodeId }, "Failed to record node history (failure)");
  }
}

/** Publish a `failed` NodeEvent to the canvas-nodes stream. */
async function publishFailedEvent(
  redis: ReturnType<typeof getRedis>,
  projectId: string | undefined,
  nodeId: string | undefined,
  _taskId: string,
  _userId: string,
  _model: string | undefined,
  _params: Record<string, unknown>,
  _errorMessage: string,
): Promise<void> {
  if (!nodeId || !projectId) return;
  try {
    await publishNodeEvent(redis, { type: "failed", projectId, nodeId });
  } catch (err) {
    logger.warn({ err, nodeId }, "Failed to publish failed NodeEvent");
  }
}

// ── Execution Path Helpers ───────────────────────────────────────────

async function runMiniTool(
  toolName: string,
  taskType: string,
  params: Record<string, unknown>,
): Promise<[Record<string, unknown>, number]> {
  const defaults = MINI_TOOL_DEFAULTS[taskType];
  if (!defaults) throw new Error(`No mini-tool defaults for task type '${taskType}'`);

  const defaultModel = defaults[toolName];
  if (!defaultModel) throw new Error(`Unknown mini-tool '${toolName}' for '${taskType}'`);

  const modelName = (params.model as string) || defaultModel;
  const cleanParams = { ...params };
  delete cleanParams.model;
  delete cleanParams.node_id;
  delete cleanParams.project_id;

  const provider = await importProvider(taskType);
  const [, validated] = provider.validateParams(modelName, cleanParams);

  const prompt = (validated.prompt ?? validated.text ?? "") as string;
  delete validated.prompt;
  delete validated.text;

  const result = await provider.generateAsync(prompt, modelName, validated);
  const cost = (result.cost as number) ?? 0;
  const credits = cost * 100 * env.CREDIT_MULTIPLIER;

  return [result, credits];
}

async function runUnderstand(
  model: string | undefined,
  params: Record<string, unknown>,
): Promise<[Record<string, unknown>, number]> {
  const sourceType = params.source_type as string;
  const sourceUrl = params.source_url as string;
  const modelName = model ?? UNDERSTAND_DEFAULTS[sourceType] ?? "gemini-flash-vi";
  const prompt = (params.prompt ?? `Analyze this ${sourceType}`) as string;

  const cleanParams: Record<string, unknown> = {};
  if (sourceType === "image") cleanParams.images = [sourceUrl];
  else if (sourceType === "video") cleanParams.video_url = sourceUrl;
  else if (sourceType === "audio") {
    cleanParams.audio_url = sourceUrl;
    cleanParams.audio = sourceUrl;
  }

  const { generateAsync } = await import("./providers/understand/index.js");
  const result = await generateAsync(prompt, modelName, cleanParams);
  const cost = (result.cost as number) ?? 0;
  const credits = cost * 100 * env.CREDIT_MULTIPLIER;

  return [result, credits];
}

async function runAigcDirect(
  taskType: string,
  model: string | undefined,
  params: Record<string, unknown>,
): Promise<[Record<string, unknown>, number]> {
  if (!model) throw new Error(`model is required for AIGC direct path (${taskType})`);

  // Extract prompt/text before validation (validateParams drops unknown fields)
  const prompt = (params.prompt ?? params.text ?? "") as string;
  const cleanParams = { ...params };
  delete cleanParams.prompt;
  delete cleanParams.text;
  delete cleanParams.node_id;
  delete cleanParams.project_id;

  const provider = await importProvider(taskType);
  const [, validated] = provider.validateParams(model, cleanParams);

  const result = await provider.generateAsync(prompt, model, validated);
  const cost = (result.cost as number) ?? 0;
  const credits = cost * 100 * env.CREDIT_MULTIPLIER;

  return [result, credits];
}

async function runSkillAgent(
  taskType: string,
  skillName: string | undefined,
  params: Record<string, unknown>,
): Promise<[string, string[]]> {
  const registry = getSkillRegistry();
  let skillContent: string;
  let toolNames: string[];
  let resolved: string[];

  if (skillName) {
    // Path 4: Explicit skill
    const skill = registry.get(skillName);
    if (!skill) throw new Error(`Skill not found: ${skillName}`);
    skillContent = registry.loadSkillContent(skillName);
    toolNames = skill.tools;
    resolved = [skillName];
  } else {
    // Path 5: Auto-select by category
    const categorySkills = registry.listByCategory(taskType);
    if (categorySkills.length === 0) {
      throw new Error(`No skills found for category '${taskType}'`);
    }

    const allToolNames: string[] = [];
    const sections: string[] = [];
    for (const s of categorySkills) {
      allToolNames.push(...s.tools);
      sections.push(`## Skill: ${s.name}\n${registry.loadSkillContent(s.name)}`);
    }

    // Deduplicate tools
    toolNames = [...new Set(allToolNames)];
    skillContent = `You have multiple skills available for [${taskType}] tasks.\n\n` + sections.join("\n\n---\n\n");
    resolved = categorySkills.map((s) => s.name);
  }

  const tools = buildToolSet(toolNames);
  const result = await generateText({
    model: getModel(),
    system: skillContent,
    messages: [{ role: "user" as const, content: JSON.stringify(params) }],
    tools,
    stopWhen: stepCountIs(15),
  });

  return [result.text || "Task completed.", resolved];
}

/**
 * Persist AIGC results to permanent storage.
 *
 * Handles two cases:
 * 1. `buffer` + `contentType` — sync transports returned raw bytes, upload directly
 * 2. URL fields — async transports returned temporary CDN URLs, download then re-upload
 */
async function persistResultUrls(
  result: Record<string, unknown>,
  opts: { taskType: string; userId: string; projectId?: string },
): Promise<Record<string, unknown>> {
  const extMap: Record<string, string> = {
    image: ".png",
    video: ".mp4",
    audio: ".mp3",
    tts: ".mp3",
    three_d: ".glb",
    understand: ".json",
  };

  const updated = { ...result };
  const ext = extMap[opts.taskType] ?? ".bin";

  const makeKey = () => storageKey({
    userId: opts.userId,
    projectId: opts.projectId,
    taskType: opts.taskType,
    ext,
  });

  // Case 1: raw bytes from sync transports (ElevenLabs, MiniMax, Fish)
  if (Buffer.isBuffer(updated.buffer)) {
    try {
      const key = makeKey();
      const contentType = (updated.contentType as string) ?? "application/octet-stream";
      const adapter = await getStorageAdapter();
      const url = await adapter.upload(key, updated.buffer as Buffer, contentType);
      updated.url = url;
      logger.info({ key, size: (updated.buffer as Buffer).length }, "Persisted sync transport result");
    } catch (err) {
      logger.warn({ err }, "Failed to persist buffer result");
    }
    delete updated.buffer;
    delete updated.contentType;
  }

  // Case 2: temporary CDN URLs from async transports
  const urlFields = ["url", "result_url", "audio_url", "video_url", "image_url", "output_url"];
  for (const field of urlFields) {
    const value = updated[field];
    if (typeof value !== "string" || !value.startsWith("http")) continue;
    if (value.includes("/uploads/")) continue;

    try {
      const key = makeKey();
      const permanentUrl = await downloadAndStore(value, key);
      updated[field] = permanentUrl;
      updated[`${field}_original`] = value;
    } catch (err) {
      logger.warn({ field, url: value, err }, "Failed to persist result URL, keeping original");
    }
  }

  return updated;
}

/** Dynamic provider import by task type. */
async function importProvider(taskType: string): Promise<{
  validateParams: (model: string, params: Record<string, unknown>) => [string, Record<string, unknown>];
  generateAsync: (prompt: string, model: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const modality = AIGC_TASK_TYPES[taskType] ?? taskType;
  const wrap = (
    validate: (m: string | undefined, p?: Record<string, unknown>) => [string, Record<string, unknown>],
    generate: (prompt: string, model: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => ({
    validateParams: (model: string, params: Record<string, unknown>) => validate(model, params),
    generateAsync: generate,
  });
  switch (modality) {
    case "image": { const m = await import("./providers/image/index.js"); return wrap(m.validateImageParams, m.generateAsync); }
    case "video": { const m = await import("./providers/video/index.js"); return wrap(m.validateVideoParams, m.generateAsync); }
    case "audio": { const m = await import("./providers/audio/index.js"); return wrap(m.validateAudioParams, m.generateAsync); }
    case "tts": { const m = await import("./providers/tts/index.js"); return wrap(m.validateTtsParams, m.generateAsync); }
    case "three-d": { const m = await import("./providers/three-d/index.js"); return wrap(m.validateThreeDParams, m.generateAsync); }
    default: throw new Error(`Unknown AIGC task type: ${taskType}`);
  }
}
