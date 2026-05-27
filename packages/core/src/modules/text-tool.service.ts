/**
 * Text mini-tool service — streaming AI text operations.
 *
 * Unlike AIGC tools (Worker + Yjs), text tools run directly in the
 * API process and stream results via SSE. The user decides whether
 * to accept or reject the result. Credits are deducted after
 * streaming completes (based on actual token usage).
 */

import { streamText, stepCountIs } from "ai";
import { t } from "@breatic/shared";
import { getModel } from "../agent/llm.js";
import { getModelForTool, getPromptForTool } from "../config/text-tools.js";
import { env } from "../config/env.js";
import * as creditService from "./credit.service.js";
import { getRedis } from "../infra/redis.js";

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
 *
 * @returns `true` if lock acquired, `false` if user already has an active request
 */
async function acquireLock(userId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `${env.ENV}:text-tool-lock:${userId}`;
  const result = await redis.set(key, "1", "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

/** Release the per-user concurrency lock. */
async function releaseLock(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${env.ENV}:text-tool-lock:${userId}`);
}

/**
 * Execute a text mini-tool with streaming output.
 *
 * @param userId - Authenticated user ID
 * @param tool - Tool name (e.g. "polish", "generate")
 * @param params - Tool parameters (document, selection, etc.)
 * @param signal - AbortSignal for cancellation on client disconnect
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

  try {
    const modelString = getModelForTool(tool);
    const systemPrompt = getPromptForTool(tool);
    const userMessage = buildUserMessage(tool, params);

    const result = streamText({
      model: getModel(modelString),
      system: systemPrompt,
      messages: [{ role: "user" as const, content: userMessage }],
      stopWhen: stepCountIs(1),
      temperature: 0.7,
      abortSignal: signal,
    });

    for await (const part of result.fullStream) {
      if (signal.aborted) break;

      if (part.type === "text-delta") {
        yield { type: "text_delta", text: part.text };
      }
    }

    // Get final usage
    const usage = await result.usage;
    totalTokens = usage?.totalTokens ?? 0;

    // Deduct credits based on token usage
    const creditsUsed = await deductForTokens(userId, totalTokens, tool, idempotencyKey);

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
    const creditsUsed = await deductForTokens(userId, totalTokens, tool, idempotencyKey);

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
 * Deduct credits based on token consumption.
 *
 * Uses a simple rate: 1 credit per 1000 tokens (configurable via CREDIT_MULTIPLIER).
 *
 * Billed through `deductOnce` with the per-request idempotency key so a
 * retry of the same HTTP request (same `Idempotency-Key` header) charges
 * at most once.
 *
 * @returns Credits actually deducted
 */
async function deductForTokens(
  userId: string,
  tokens: number,
  tool: string,
  idempotencyKey: string,
): Promise<number> {
  if (tokens === 0) return 0;

  // 1 credit = 1 US cent = ~1000 tokens at typical pricing
  const credits = Math.ceil((tokens / 1000) * env.CREDIT_MULTIPLIER);
  if (credits <= 0) return 0;

  try {
    await creditService.deductOnce(
      userId,
      `texttool:${idempotencyKey}`,
      credits,
      `Text tool: ${tool}`,
    );
    return credits;
  } catch {
    // Don't fail the response if credit deduction fails (e.g.
    // insufficient credits). The text was already generated.
    // Returning 0 signals "billed nothing" to the application
    // caller, which can decide to emit a warn audit log if the
    // observed `creditsUsed === 0 && tokens > 0` invariant holds.
    return 0;
  }
}
