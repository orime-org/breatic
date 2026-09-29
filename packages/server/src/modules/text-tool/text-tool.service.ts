// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Text mini-tool service — streaming AI text operations.
 *
 * Unlike AIGC tools (Worker + Yjs), text tools run directly in the
 * API process and stream results via SSE. The user decides whether
 * to accept or reject the result. The model call is recorded as its
 * response arrives, and the run is charged what the record adds up to.
 */

import { stepCountIs } from "ai";
import { streamTextRetry } from "@breatic/domain";
import { t } from "@breatic/shared";
import { getModel, resolveProvider } from "@breatic/domain";
import { getModelForTool, getPromptForTool } from "@server/config/text-tools.js";
import { env, logger } from "@breatic/core";
import { creditLotService, createUsageRecorder } from "@breatic/domain";
import type { UsageRecorder } from "@breatic/domain";
import { watchInterruptedCall, type InterruptedCallWatch } from "@server/agent/interrupted-call.js";
import { getRedis } from "@breatic/core";

/** SSE event yielded during text tool execution. */
export type TextToolEvent =
  | { type: "text_delta"; text: string }
  | { type: "done"; tokens: number; creditsUsed: number }
  | { type: "aborted"; tokens: number; creditsUsed: number }
  | { type: "error"; message: string; err: unknown };

const LOCK_TTL_SECONDS = 120;

/**
 * Build the user message from tool params.
 *
 * For operation tools: includes full document + marked selection.
 * For generation tools: includes instructions + tool-specific params.
 * @param tool - Tool name selecting the prompt shape (e.g. "translate", "character", "script").
 * @param params - Raw tool params such as `document`, `selection`, `instructions`, and tool-specific extras.
 * @returns The assembled user message passed to the model.
 */
function buildUserMessage(tool: string, params: Record<string, unknown>): string {
  const document = params.document as string | undefined;
  const selection = params.selection as string | undefined;
  const instructions = params.instructions as string | undefined;

  // Operation tools: document + selection context
  if (selection && document) {
    let msg = `Here is the full document:\n---\n${document}\n---\n\n`;
    msg += `The user selected this text:\n---\n${selection}\n---\n`;
    if (instructions) msg += `\nAdditional instructions: ${instructions}`;

    // Tool-specific extras
    if (tool === "translate" && params.language) {
      msg += `\nTranslate to: ${params.language as string}`;
    }
    if (tool === "rewrite" && params.style) {
      msg += `\nTarget style: ${params.style as string}`;
    }

    return msg;
  }

  // Generation tools: instructions + params
  switch (tool) {
    case "generate":
      return instructions ?? "Generate text.";
    case "character": {
      let msg = `Create a character named "${params.name as string}".`;
      if (params.traits) msg += `\nTraits: ${params.traits as string}`;
      if (params.context) msg += `\nContext: ${params.context as string}`;
      if (document) msg += `\n\nReference document:\n---\n${document}\n---`;
      return msg;
    }
    case "storyboard": {
      let msg = instructions ?? "Create a storyboard.";
      if (params.scene_count) msg += `\nTarget scene count: ${params.scene_count as number}`;
      if (document) msg += `\n\nReference document:\n---\n${document}\n---`;
      return msg;
    }
    case "script": {
      let msg = `Scene: ${params.scene_description as string}`;
      const chars = params.characters as string[] | undefined;
      if (chars?.length) msg += `\nCharacters: ${chars.join(", ")}`;
      if (document) msg += `\n\nReference document:\n---\n${document}\n---`;
      return msg;
    }
    default:
      return instructions ?? document ?? "Help me with this text.";
  }
}

/**
 * Acquire a per-user concurrency lock for text tools.
 * @param userId - Authenticated user ID the lock is scoped to.
 * @returns `true` if lock acquired, `false` if user already has an active request
 */
async function acquireLock(userId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `${env.ENV}:text-tool-lock:${userId}`;
  const result = await redis.set(key, "1", "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

/**
 * Release the per-user concurrency lock.
 * @param userId - Authenticated user ID whose lock is released.
 */
async function releaseLock(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${env.ENV}:text-tool-lock:${userId}`);
}

/**
 * Execute a text mini-tool with streaming output.
 * @param userId - Authenticated user ID
 * @param tool - Tool name (e.g. "polish", "generate")
 * @param params - Tool parameters (document, selection, etc.)
 * @param signal - AbortSignal for cancellation on client disconnect
 * @param idempotencyKey - Per-request key used to bill the run at most once across success and error paths.
 * @yields TextToolEvent stream
 */
export async function* executeTextTool(
  userId: string,
  tool: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  idempotencyKey: string,
): AsyncGenerator<TextToolEvent> {
  // Concurrency lock
  const locked = await acquireLock(userId);
  if (!locked) {
    yield {
      type: "error",
      message: t("server.text_tool.already_running"),
      err: new Error("acquireLock returned false (already_running)"),
    };
    return;
  }

  let totalTokens = 0;
  // Declared out here so both exits reach them. The model call is recorded
  // when its response arrives, so a run that died before that records and
  // charges nothing; a run that died after it is charged the same as the
  // success path. The second case is reached when the consumer throws while
  // taking an event: the throw comes back out of the suspended `yield`, by
  // which point the model has already billed us.
  let modelString: string | null = null;
  const usage = createUsageRecorder({
    operationKey: `texttool:${idempotencyKey}`,
    feature: "text_tool",
    actorUserId: userId,
    // Null because this route never took one (#122); see `chargeRecorded`.
    projectId: null,
    onMissingCost: (row) => logger.error({ row, userId, tool }, "agent_usage_cost_missing"),
  });
  // Set once the model is known; watches for an OpenRouter call cut off
  // before it reported its cost.
  let interrupted: InterruptedCallWatch | undefined;

  try {
    const model = getModelForTool(tool);
    modelString = model;
    const watch = watchInterruptedCall({
      model,
      operationKey: `texttool:${idempotencyKey}`,
      feature: "text_tool",
      actorUserId: userId,
      projectId: null,
      description: `Text tool: ${tool}`,
    });
    interrupted = watch;
    const systemPrompt = getPromptForTool(tool);
    const userMessage = buildUserMessage(tool, params);

    const result = streamTextRetry({
      model: getModel(modelString),
      system: systemPrompt,
      messages: [{ role: "user" as const, content: userMessage }],
      stopWhen: stepCountIs(1),
      temperature: 0.7,
      abortSignal: signal,
      ...watch.streamOptions,
      onLanguageModelCallEnd: ({ usage: spent, providerMetadata }) => {
        watch.ended();
        totalTokens += spent.totalTokens ?? 0;
        usage.recordModelCall({
          source: "model",
          model,
          provider: resolveProvider(model),
          usage: spent,
          providerMetadata,
        });
      },
    });

    for await (const part of result.fullStream) {
      if (signal.aborted) break;

      if (part.type === "text-delta") {
        yield { type: "text_delta", text: part.text };
      }
    }

    const creditsUsed = await chargeRecorded(
      userId,
      usage,
      interrupted,
      tool,
      idempotencyKey,
      modelString,
      totalTokens,
    );

    if (signal.aborted) {
      yield { type: "aborted", tokens: totalTokens, creditsUsed };
    } else {
      yield { type: "done", tokens: totalTokens, creditsUsed };
    }
    // Caller (server SSE route) logs `text_tool_completed` audit
    // line from the consumed `done` / `aborted` event.
  } catch (err) {
    // Deduct for consumed tokens even on error. Uses the same
    // idempotencyKey as the success path so the catch branch can't
    // double-charge if somehow both run for the same request.
    const creditsUsed = await chargeRecorded(
      userId,
      usage,
      interrupted,
      tool,
      idempotencyKey,
      modelString,
      totalTokens,
    );

    if (signal.aborted) {
      yield { type: "aborted", tokens: totalTokens, creditsUsed };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      // Embed the raw error on the event so the application caller
      // (server SSE route) can log it with full request context.
      yield { type: "error", message, err };
    }
  } finally {
    await releaseLock(userId);
  }
}

/**
 * Charge a text-tool run what its recorder adds up to.
 *
 * Which pool pays is decided by the project a generation runs in, and this
 * route carries no project id (#122). Until it does, a run records its usage
 * and charges nobody, so the number returned here is zero.
 *
 * The per-request idempotency key makes a retry of the same HTTP request
 * charge at most once.
 * @param userId - Authenticated user ID the usage is recorded against.
 * @param usage - The run's recorder.
 * @param interrupted - The run's watch for a call cut off before it reported
 *   its cost, once the model was known.
 * @param tool - Tool name recorded on the ledger row.
 * @param idempotencyKey - Per-request key combined into the `texttool:` ref to guarantee idempotency.
 * @param modelString - The model that produced the text, `null` when the run
 *   failed before one was resolved.
 * @param tokens - Tokens the run used, for the log line alone.
 * @returns Credits actually charged.
 */
async function chargeRecorded(
  userId: string,
  usage: UsageRecorder,
  interrupted: InterruptedCallWatch | undefined,
  tool: string,
  idempotencyKey: string,
  modelString: string | null,
  tokens: number,
): Promise<number> {
  // A call cut off before it reported its cost is looked up and charged
  // later, under a key of its own.
  await interrupted?.handOff().catch((err: unknown) =>
    logger.error({ err, userId, tool }, "usage_lookup_enqueue_failed"),
  );
  try {
    const credits = await usage.settle();
    if (credits <= 0) return 0;
    const outcome = await creditLotService.chargeOnceForGeneration(
      `texttool:${idempotencyKey}`,
      {
        projectId: null,
        actorUserId: userId,
        amount: credits,
        model: modelString ?? undefined,
        provider: modelString === null ? undefined : resolveProvider(modelString),
        description: `Text tool: ${tool}`,
      },
    );
    return outcome?.charged ?? 0;
  } catch (err) {
    // The text is already generated and already streamed, so this failure
    // has nowhere to go: the caller gets its `done` event either way and
    // sees nothing. This line is the only trace the run leaves of money it
    // used and did not collect.
    logger.error(
      { err, userId, tool, tokens },
      "text_tool_credit_charge_failed",
    );
    return 0;
  }
}
