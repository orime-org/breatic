// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Main Agent — streaming chat with AI SDK.
 *
 * Replaces the Python ToolCallRunner with AI SDK's built-in
 * `streamText()` + `maxSteps` for automatic tool-call looping.
 */

import { stepCountIs } from "ai";
import { streamTextRetry } from "@breatic/domain";
import type { ModelMessage, TextPart, ImagePart } from "ai";

import { getModel, resolveProvider } from "@breatic/domain";
import { buildAgentConfig, finalizeTurn } from "@breatic/domain";
import type { ResolvedAgentConfig } from "@breatic/domain";
import { buildSystemPrompt } from "@server/agent/context.js";
import { getAgentConfig } from "@breatic/core";
import { env } from "@breatic/core";
import { creditService } from "@breatic/domain";
import { SSEEventType } from "@server/agent/types.js";
import type { SSEEvent } from "@server/agent/types.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import { consolidateIfNeeded } from "@server/agent/memory-consolidator.js";
import { getContext } from "@breatic/core";
import { logger } from "@breatic/core";
import { ASK_USER_SENTINEL, parseInteractionSentinel } from "@server/agent/interaction-sentinel.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * Main Agent for streaming chat interactions.
 *
 * Reads userId, conversationId, projectId, memoryContext, and compressedHistory
 * from the AsyncLocalStorage request context (set by route handler).
 */
export class MainAgent {
  /**
   * The current request-scoped store (userId, conversationId, projectId,
   * memoryContext, compressedHistory, billing) from AsyncLocalStorage.
   * @returns The active request context for this agent turn.
   */
  private get ctx(): ReturnType<typeof getContext> {
    return getContext();
  }

  /**
   * Run a streaming chat turn with the user.
   * @param userMessage - The user's text message
   * @param resources - Optional attached resource URLs (images, files)
   * @yields SSE events for real-time frontend rendering
   */
  async *chat(userMessage: string, resources?: string[]): AsyncGenerator<SSEEvent> {
    const { conversationId, memoryContext, compressedHistory } = this.ctx;

    // Save user message. Capture the assigned turnIndex so billing can
    // build a stable refKey (`turn:${conversationId}:${turnIndex}`) that
    // survives retries — see core/src/modules/credit.service.ts `deductOnce`.
    const turnIndex = await conversationRepo.addMessage(conversationId, {
      role: "user",
      content: userMessage,
      ts: new Date().toISOString(),
    });
    this.ctx.billing = { turnIndex };

    // One factory decides model, instructions and tools — see
    // domain/agent/agent-config.ts for why nothing else may assemble them.
    const agentConfig = buildAgentConfig({
      basePrompt: buildSystemPrompt(),
      memoryContext,
      interactive: true,
    });

    // Build messages array from pre-compressed history
    const userContent = MainAgent.buildUserContent(userMessage, resources);
    const messages = [
      ...compressedHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ] as ModelMessage[];

    yield* this.runStream(agentConfig, messages);
  }

  /**
   * Execute a skill command (e.g. `/skill generate_image_plan ...`).
   * @param skillName - Name of the skill to invoke
   * @param userInput - User's input text for the skill
   * @param resources - Optional attached resources
   * @yields SSE events
   */
  async *handleSkillCommand(
    skillName: string,
    userInput: string,
    resources?: string[],
  ): AsyncGenerator<SSEEvent> {
    const { conversationId, memoryContext, compressedHistory } = this.ctx;

    // Whether the skill exists is not asked here. `assertUserMayInvoke` on
    // the route has already answered it — with a 404 the client can act on,
    // before a message was saved or a stream opened. Asking again would be a
    // second answer to a settled question, which is how the two entry points
    // drifted apart in the first place.

    // Save user command. Capture the assigned turnIndex for billing refKey,
    // same reason as `chat()` above.
    const turnIndex = await conversationRepo.addMessage(conversationId, {
      role: "user",
      content: `/skill ${skillName} ${userInput}`,
      ts: new Date().toISOString(),
    });
    this.ctx.billing = { turnIndex };

    const agentConfig = buildAgentConfig({
      skillName,
      basePrompt: buildSystemPrompt(),
      memoryContext,
      interactive: true,
    });

    const userContent = MainAgent.buildUserContent(
      `/skill ${skillName} ${userInput}`,
      resources,
    );
    const messages = [
      ...compressedHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ] as ModelMessage[];

    yield* this.runStream(agentConfig, messages);
  }

  /**
   * Core streaming loop using AI SDK `streamText()`.
   *
   * AI SDK handles the tool-call iteration automatically via `maxSteps`.
   *
   * The loop is wrapped in try/finally so the turn's obligations run
   * however it ends — including the user closing the page, which stops
   * this generator where it stands.
   * @param agentConfig - Model, instructions and tools, from the one factory that decides them.
   * @param messages - Conversation history plus the current user message.
   * @yields SSE events (chat chunks, tool hints, interaction prompts, plan, done) for real-time frontend rendering.
   */
  private async *runStream(
    agentConfig: ResolvedAgentConfig,
    messages: ModelMessage[],
  ): AsyncGenerator<SSEEvent> {
    const { userId, conversationId, projectId } = this.ctx;
    const agentCfg = getAgentConfig();

    const result = streamTextRetry({
      model: getModel(agentConfig.modelId),
      system: agentConfig.instructions,
      messages,
      tools: agentConfig.tools,
      stopWhen: stepCountIs(agentCfg.max_tool_iterations),
      temperature: 0.2,
    });

    let fullResponse = "";
    let thinkingContent = "";
    let creditsUsed = 0;
    const toolCallLog: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    // Tokens are counted off the stream as it goes past, never from
    // `result.usage`. That getter is not a passive read: it chains to
    // `finalStep` to `steps`, and `steps` calls `consumeStream()`. On the
    // exit that matters most — the user closing the page while the model
    // loop is still mid-flight — reading it would drive the rest of that
    // loop after everyone has gone, running real provider calls and real
    // tool calls nobody asked for, then bill for them. Every step announces
    // what it spent in a `finish-step` part, so adding those up as they
    // arrive gives the figure with none of that, on every exit alike.
    let tokensUsed = 0;

    // Everything below runs inside try/finally so the turn's obligations are
    // met however it ends. Three of the four exits used to skip them: the
    // user closing the page (the consumer calls `.return()` on this
    // generator and nothing after the loop runs), the model throwing, and a
    // blocking interaction tool returning early. In each the reply went
    // unsaved and the turn unbilled.
    // How this turn ended, for the log. It starts at the exit nothing has to
    // announce — the client walking away, where control never comes back to
    // this function's own code — and each of the other three says so on its
    // way out. A default of "completed" is what let a disconnect log itself
    // as a clean finish.
    let exit: "aborted" | "completed" | "blocked" | "failed" = "aborted";

    try {
      stream: for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            fullResponse += part.text;
            yield this.sse(SSEEventType.CHAT_CHUNK, { text: part.text });
            break;

          case "reasoning-delta":
            thinkingContent += part.text;
            break;

          case "finish-step":
            tokensUsed += part.usage?.totalTokens ?? 0;
            break;

          case "tool-call":
            toolCallLog.push({
              id: part.toolCallId,
              name: part.toolName,
              arguments: part.input as Record<string, unknown>,
            });
            yield this.sse(SSEEventType.AGENT_TOOL_HINT, { hint: part.toolName });
            break;

          case "tool-result": {
            const toolCall = toolCallLog.find((tc) => tc.id === part.toolCallId);

            // Stringify output once; reused for sentinel detection,
            // interaction-tool payload parse, and the `role: 'tool'`
            // history message that the LLM sees on subsequent turns.
            const output = "output" in part ? part.output : undefined;
            const resultStr = typeof output === "string" ? output : JSON.stringify(output);

            // Pre-parse interaction-tool payload BEFORE persisting so the
            // structured result lands on the assistant `tool_calls[0].result`
            // record. History reload reads that field directly — sentinel
            // decoding stays a backend protocol concern and never leaks
            // into the frontend persistence boundary.
            const interaction = parseInteractionSentinel(resultStr);

            if (toolCall) {
              await conversationRepo.addMessage(conversationId, {
                role: "assistant",
                content: "",
                ts: new Date().toISOString(),
                tool_calls: [
                  interaction ? { ...toolCall, result: interaction.payload } : toolCall,
                ],
              });
              await conversationRepo.addMessage(conversationId, {
                role: "tool",
                content: resultStr,
                ts: new Date().toISOString(),
                tool_call_id: part.toolCallId,
                name: toolCall.name,
              });
            }

            if (resultStr.startsWith(ASK_USER_SENTINEL)) {
              try {
                const payload = JSON.parse(resultStr.slice(ASK_USER_SENTINEL.length)) as Record<string, unknown>;
                yield this.sse(SSEEventType.AGENT_ASK, payload);
              } catch {
                yield this.sse(SSEEventType.AGENT_ASK, { question: resultStr });
              }
              // The turn stops here waiting for the user, but it still owes
              // an ending. Breaking rather than returning keeps the exit on
              // one path so `chat_done` cannot be skipped.
              exit = "blocked";
              break stream;
            }

            if (interaction) {
              yield this.sse(interaction.event, interaction.payload);
              // Only the tools that asked the user something stop here. The
              // ones that merely drew a card let the model write on around
              // them, and let it draw more than one in a turn.
              if (interaction.blocking) {
                exit = "blocked";
                break stream;
              }
            }
            break;
          }
        }
      }
      // Two ways to arrive here: the stream ran out, or a blocking tool
      // broke out of it. That one has already recorded itself, so only the
      // untouched default counts as a clean finish.
      if (exit === "aborted") exit = "completed";
    } catch (err) {
      exit = "failed";
      logger.error({ err, userId, conversationId }, "agent_turn_failed");
      yield this.sse(SSEEventType.ERROR, {
        message: "The assistant could not finish this turn.",
      });
    } finally {
      // Memory consolidation is an LLM call of its own and nobody is waiting
      // for it — the user is waiting for the turn to be over. Starting it
      // here rather than awaiting it keeps it out from in front of
      // `chat_done`, and starting it inside the finally means a disconnect
      // still triggers it. Its failure is logged here because it has nobody
      // left to return to.
      void consolidateIfNeeded(userId, conversationId, projectId).catch((err: unknown) =>
        logger.warn({ err, userId, conversationId }, "memory_consolidation_failed"),
      );

      const failures = await finalizeTurn({
        steps: {
          persist: fullResponse
            ? async () => {
                await conversationRepo.addMessage(conversationId, {
                  role: "assistant",
                  content: fullResponse,
                  ts: new Date().toISOString(),
                  ...(thinkingContent ? { thinking: thinkingContent } : {}),
                });
              }
            : undefined,
          bill: async () => {
            if (tokensUsed === 0) return;

            creditsUsed = Math.ceil((tokensUsed / 1000) * env.CREDIT_MULTIPLIER);
            const billingTurnIndex = this.ctx.billing?.turnIndex;
            if (billingTurnIndex === undefined) {
              throw new Error("MainAgent.runStream: billing.turnIndex not initialized");
            }
            // The turn-scoped refKey makes this idempotent: an SSE reconnect
            // or a re-entry on the same turn will not double-charge.
            await creditService.deductOnce(
              userId,
              `turn:${conversationId}:${billingTurnIndex}`,
              creditsUsed,
              "Agent chat",
              {
                tokensUsed,
                model: agentConfig.modelId,
                provider: resolveProvider(agentConfig.modelId),
              },
            );
          },
        },
      });

      // The finalizer does not log — it is in domain, which has no logger.
      // This is the layer that knows the user and the conversation.
      for (const failure of failures) {
        logger.error(
          { err: failure.error, userId, conversationId, step: failure.step },
          "turn_finalizer_step_failed",
        );
      }

      logger.info({
        userId,
        conversationId,
        responseLength: fullResponse.length,
        creditsUsed,
        exit,
      }, "agent_response");

      // Inside the finally so every exit emits it. A turn that ends without
      // one leaves the frontend with nothing to switch out of its in-flight
      // state — the stop button never clears.
      yield this.sse(SSEEventType.CHAT_DONE, {
        conversationId,
        creditsUsed,
      });
    }
  }

  /**
   * Wrap a payload into the SSE event envelope.
   *
   * SSE events intentionally carry NO ownership ids. The stream is a
   * per-request private response, and the conversation's user_id /
   * project_id already live on the `conversations` row — repeating them on
   * every event (incl. each token chunk) is redundant and has no consumer
   * (the frontend routes by stream, not by id). See CLAUDE.md "SSE".
   * @param event - The SSE event type to emit.
   * @param data - The event payload.
   * @returns The SSE event envelope.
   */
  private sse(event: SSEEventType, data: Record<string, unknown>): SSEEvent {
    return { event, data };
  }

  /**
   * Build multimodal user content from text + resource URLs.
   * @param text - User's text message
   * @param resources - Optional attached resource URLs
   * @returns Plain string or multimodal content array
   */
  static buildUserContent(text: string, resources?: string[]): string | Array<TextPart | ImagePart> {
    if (!resources?.length) return text;

    const parts: Array<TextPart | ImagePart> = [
      { type: "text", text },
    ];

    for (const url of resources) {
      const ext = url.slice(url.lastIndexOf(".")).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        parts.push({ type: "image", image: new URL(url) });
      } else {
        parts.push({ type: "text", text: `[Attached resource: ${url}]` });
      }
    }

    return parts;
  }

}
