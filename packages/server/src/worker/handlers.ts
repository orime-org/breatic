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
import { getModel } from "../agent/llm.js";
import { buildToolSet } from "../agent/tools/index.js";
import { getSkillRegistry } from "../agent/skills-loader.js";
import { getRedis } from "../infra/redis.js";
import { downloadAndStore, getStorageAdapter, storageKey } from "../infra/storage/index.js";
import * as taskService from "../modules/task.service.js";
import * as creditService from "../modules/credit.service.js";
import * as nodeHistoryService from "../modules/node-history.service.js";
import { publishNodeEvent } from "../infra/event-stream.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

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
 * @param job - BullMQ job with TaskJobData payload
 * @returns Result dict
 */
export async function runTask(job: Job<TaskJobData>): Promise<Record<string, unknown>> {
  const { taskId, taskType, userId, projectId, params, model, skillName, source, toolName } = job.data;

  const redis = getRedis();

  // Mark running. The `handling` state + `handlingBy` are already set
  // by the API when the task was created (see POST /canvas/tasks), so
  // the Worker does NOT publish a handling event on pickup — doing so
  // would just re-broadcast the same state Collab already wrote.
  await taskService.markRunning(taskId, job.id ?? "");

  try {
    let result: Record<string, unknown>;
    let creditsUsed = 0;
    let resolvedSkills: string[] = [];

    // Time the AIGC model call
    const startTime = performance.now();

    // Path 1: Mini-tool
    if (source === "mini_tool" && toolName) {
      [result, creditsUsed] = await runMiniTool(toolName, taskType, params);
    }
    // Path 2: Understand
    else if (taskType === "understand") {
      [result, creditsUsed] = await runUnderstand(model, params);
    }
    // Path 3: AIGC Direct
    else if (taskType in AIGC_TASK_TYPES && !skillName) {
      [result, creditsUsed] = await runAigcDirect(taskType, model, params);
    }
    // Path 4+5: Skill agent
    else {
      const [text, skills] = await runSkillAgent(taskType, skillName, params);
      resolvedSkills = skills;
      try {
        result = JSON.parse(text) as Record<string, unknown>;
      } catch {
        result = { content: text };
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    // Persist AIGC results (buffer uploads + CDN URL downloads) to storage
    result = await persistResultUrls(result, { taskType, userId, projectId });

    // Extract video cover image (first frame)
    if (taskType === "video" && typeof result.url === "string") {
      const { extractVideoCover } = await import("./video-cover.js");
      const coverUrl = await extractVideoCover(result.url, { userId, projectId });
      if (coverUrl) {
        result.cover_url = coverUrl;
      }
    }

    // Set resolved skills
    await taskService.setResolvedSkills(taskId, resolvedSkills);

    // Deduct credits
    if (creditsUsed > 0) {
      await creditService.deduct(userId, creditsUsed, `Task: ${taskType}`, taskId);
    }

    // Mark completed
    await taskService.markCompleted(taskId, result, creditsUsed, durationMs);

    // Record in node history (non-fatal — failure here shouldn't fail the task)
    const nodeId = params.node_id as string | undefined;
    if (nodeId && projectId && typeof result.url === "string") {
      try {
        await nodeHistoryService.recordGenerationSuccess({
          projectId,
          nodeId,
          userId,
          content: result.url as string,
          thumbnailUrl: (result.cover_url as string | undefined) ?? (taskType === "image" ? result.url as string : undefined),
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

    // Publish completion — Collab will update the canvas node, clear
    // handlingBy, and release the Redis node lock.
    const nodeIdForEvent = params.node_id as string | undefined;
    if (nodeIdForEvent && projectId) {
      await publishNodeEvent(redis, {
        type: "completed",
        projectId,
        nodeId: nodeIdForEvent,
        content: (result.url as string | undefined) ?? (result.content as string | undefined) ?? "",
        cover_url: result.cover_url as string | undefined,
      });
    }

    logger.info({ taskId, taskType, skillName, resolvedSkills, creditsUsed, durationMs }, "task_completed");
    return result;

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await taskService.markFailed(taskId, errorMsg);

    // Record failure in node history (non-fatal)
    const nodeId = params.node_id as string | undefined;
    if (nodeId && projectId) {
      try {
        await nodeHistoryService.recordGenerationFailure({
          projectId,
          nodeId,
          userId,
          errorMessage: errorMsg,
          taskId,
          metadata: { model, params },
        });
      } catch (historyErr) {
        logger.warn({ err: historyErr, taskId, nodeId }, "Failed to record node history (failure)");
      }
    }

    // Publish failure — Collab will clear handlingBy, set state=idle
    // (without touching content), and release the Redis node lock.
    const failedNodeId = params.node_id as string | undefined;
    if (failedNodeId && projectId) {
      await publishNodeEvent(redis, {
        type: "failed",
        projectId,
        nodeId: failedNodeId,
      });
    }

    logger.error({ taskId, error: errorMsg }, "task_failed");
    throw err;
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

  const { generateAsync } = await import("../providers/understand/index.js");
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
    case "image": { const m = await import("../providers/image/index.js"); return wrap(m.validateImageParams, m.generateAsync); }
    case "video": { const m = await import("../providers/video/index.js"); return wrap(m.validateVideoParams, m.generateAsync); }
    case "audio": { const m = await import("../providers/audio/index.js"); return wrap(m.validateAudioParams, m.generateAsync); }
    case "tts": { const m = await import("../providers/tts/index.js"); return wrap(m.validateTtsParams, m.generateAsync); }
    case "three-d": { const m = await import("../providers/three-d/index.js"); return wrap(m.validateThreeDParams, m.generateAsync); }
    default: throw new Error(`Unknown AIGC task type: ${taskType}`);
  }
}
