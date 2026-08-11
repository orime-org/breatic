// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Main Agent — streaming chat with AI SDK.
 *
 * Replaces the Python ToolCallRunner with AI SDK's built-in
 * `streamText()`, whose tool-call loop is bounded by `stopWhen`.
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
import { ASK_USER_SENTINEL } from "@breatic/domain";
import type { MessagePart } from "@breatic/shared";
import { SSEEventType } from "@server/agent/types.js";
import type { SSEEvent } from "@server/agent/types.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import { consolidateIfNeeded } from "@server/agent/memory-consolidator.js";
import { getContext } from "@breatic/core";
import { logger } from "@breatic/core";
import { parseInteractionSentinel, stripSentinel } from "@server/agent/interaction-sentinel.js";
import { toModelMessages } from "@server/agent/model-messages.js";

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
   * @param signal - Raised when the user stops the turn or the client goes
   *   away. Absent means this caller has no way to stop the turn.
   * @yields SSE events for real-time frontend rendering
   */
  async *chat(
    userMessage: string,
    resources?: string[],
    signal?: AbortSignal,
  ): AsyncGenerator<SSEEvent> {
    const { conversationId, memoryContext, compressedHistory } = this.ctx;

    // Save user message. Capture the assigned turnIndex so billing can
    // build a stable refKey (`turn:${conversationId}:${turnIndex}`) that
    // survives retries — see core/src/modules/credit.service.ts `deductOnce`.
    const turnIndex = await messageRepo.addMessage(conversationId, {
      role: "user",
      parts: [{ type: "text", text: userMessage }],
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
    const messages: ModelMessage[] = [
      ...toModelMessages(compressedHistory),
      { role: "user", content: userContent },
    ];

    yield* this.runStream(agentConfig, messages, signal);
  }

  /**
   * Execute a skill command (e.g. `/skill generate_image_plan ...`).
   * @param skillName - Name of the skill to invoke
   * @param userInput - User's input text for the skill
   * @param resources - Optional attached resources
   * @param signal - Raised when the user stops the turn or the client goes
   *   away. Absent means this caller has no way to stop the turn.
   * @yields SSE events
   */
  async *handleSkillCommand(
    skillName: string,
    userInput: string,
    resources?: string[],
    signal?: AbortSignal,
  ): AsyncGenerator<SSEEvent> {
    const { conversationId, memoryContext, compressedHistory } = this.ctx;

    // Whether the skill exists is not asked here. `assertSkillUsable` on
    // the route has already answered it — with a 404 the client can act on,
    // before a message was saved or a stream opened. Asking again would be a
    // second answer to a settled question, which is how the two entry points
    // drifted apart in the first place.

    // Save user command. Capture the assigned turnIndex for billing refKey,
    // same reason as `chat()` above.
    const turnIndex = await messageRepo.addMessage(conversationId, {
      role: "user",
      parts: [{ type: "text", text: `/skill ${skillName} ${userInput}` }],
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
    const messages: ModelMessage[] = [
      ...toModelMessages(compressedHistory),
      { role: "user", content: userContent },
    ];

    yield* this.runStream(agentConfig, messages, signal);
  }

  /**
   * Core streaming loop using AI SDK `streamText()`.
   *
   * AI SDK handles the tool-call iteration automatically; the step budget is
   * `stopWhen: stepCountIs(agentCfg.max_tool_iterations)`.
   *
   * The loop is wrapped in try/finally so the turn's obligations run however
   * it ends. How each ending is recorded, and why one of them cannot record
   * itself, is set out where `announced` is declared.
   * @param agentConfig - Model, instructions and tools, from the one factory that decides them.
   * @param messages - Conversation history plus the current user message.
   * @param signal - Raised when the user stops the turn or the client goes away.
   * @yields SSE events — chat chunks, tool hints, interaction prompts, an error, and the ending.
   */
  private async *runStream(
    agentConfig: ResolvedAgentConfig,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<SSEEvent> {
    const { userId, conversationId, projectId } = this.ctx;
    // Read with the others, not from inside the `finally`. `this.ctx` reaches
    // into AsyncLocalStorage, which is only guaranteed to be there while the
    // caller is still driving this generator — and the whole point of the
    // cleanup below is to survive exits where that is not the case. Three
    // context fields were already captured here and this was the odd one out.
    const billingTurnIndex = this.ctx.billing?.turnIndex;
    const agentCfg = getAgentConfig();

    const result = streamTextRetry({
      model: getModel(agentConfig.modelId),
      system: agentConfig.instructions,
      messages,
      tools: agentConfig.tools,
      stopWhen: stepCountIs(agentCfg.max_tool_iterations),
      temperature: 0.2,
      // The middle ring of the stop chain. Without it the route can notice the
      // client leaving and the loop can watch for the announcement, and the
      // model keeps running regardless: measured on ai@7.0.58, a signal handed
      // in here ends the stream within milliseconds and no further model call
      // is made, and the SDK passes it on to every tool it invokes.
      abortSignal: signal,
      // Both fields carry weight. Anthropic leaves extended thinking off
      // unless asked, so without `type` there is no reasoning to forward at
      // all; and on the adaptive tier the blocks arrive with empty text unless
      // the summary is asked for by name, so without `display` the loop would
      // forward nothing while looking like it works. `adaptive` leaves it to
      // the model whether a given question needs thinking through, which is
      // why this is not a cost paid on every turn.
      ...(agentCfg.thinking_enabled
        ? {
            providerOptions: {
              anthropic: { thinking: { type: "adaptive", display: "summarized" } },
            },
          }
        : {}),
    });

    let fullResponse = "";
    let creditsUsed = 0;

    // What this turn did, in the order it did it. One turn of the assistant is
    // one message, and this is that message being built: prose, reasoning and
    // tool use land here as they happen and go to the store together at the
    // end. Writing them out as they arrive instead is what used to split one
    // reply across three rows, leaving every reader to put it back together.
    const replyParts: MessagePart[] = [];

    // Prose and reasoning arrive in fragments, so they are held here until
    // something ends the run — a tool call, or the turn itself. Without that,
    // a reply that wrote, called a tool, then wrote again would store its two
    // halves as one block and lose where the tool sat between them.
    let pendingText = "";
    let pendingReasoning = "";

    /** Close off whatever prose and reasoning have accumulated. */
    const flushPending = (): void => {
      if (pendingReasoning) {
        replyParts.push({ type: "reasoning", text: pendingReasoning });
        pendingReasoning = "";
      }
      if (pendingText) {
        replyParts.push({ type: "text", text: pendingText });
        pendingText = "";
      }
    };

    // Tokens are counted off the stream as it goes past, never from
    // `result.usage`. That getter is not a passive read: on ai@7.0.58 it
    // returns `totalUsage`, and `totalUsage` calls `consumeStream()`. On the
    // exit that matters most — the user closing the page while the model
    // loop is still mid-flight — reading it would drive the rest of that
    // loop after everyone has gone, running real provider calls and real
    // tool calls nobody asked for, then bill for them. Every step announces
    // what it spent in a `finish-step` part, so adding those up as they
    // arrive gives the figure with none of that, on every exit alike.
    let tokensUsed = 0;

    // Everything below runs inside try/finally so the turn's obligations are
    // met however it ends. Both early exits used to skip them -- a blocking
    // interaction tool returning, and a failure -- leaving the reply unsaved
    // and the turn unbilled.
    //
    // How this turn ended. Three of the four endings say so from inside the
    // loop -- a provider failure, a stop, and a blocking tool -- and the
    // fourth, a clean finish, is filled in on the line just after it. One
    // ending says nothing at all, which is why this starts out as nothing
    // rather than as a value: the consumer walking away arrives as `.return()`
    // on this
    // generator, which resumes it at whichever `yield` it was suspended on and
    // goes straight to the `finally`, so no line in the loop gets to run. That
    // ending is read off the absence, in the `finally`.
    //
    // It used to start at "aborted" and be rewritten to "completed" after the
    // loop, which worked while that was the only silent ending. It stopped
    // working the moment a stop could announce itself: a labelled `break`
    // resumes on the line after the loop, so the announcement was overwritten
    // on the way out and every stop was recorded as a clean finish. The two
    // older `break`s survived that only because the values they set are not
    // the one being rewritten.
    let announced: "aborted" | "completed" | "blocked" | "failed" | undefined;

    // Set when a blocking tool has fired: the turn is over, but not until the
    // current step's `finish-step` goes by. That part carries the step's
    // token count and arrives after its `tool-result` (measured against the
    // real SDK: start-step, tool-call, tool-result, finish-step), so leaving
    // at the tool-result threw away everything the step had spent.
    let stopAfterStep = false;

    try {
      stream: for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            fullResponse += part.text;
            pendingText += part.text;
            yield this.sse(SSEEventType.CHAT_CHUNK, { text: part.text });
            break;

          case "reasoning-delta":
            pendingReasoning += part.text;
            // `@ai-sdk/anthropic` raises one of these with no text when it
            // forwards the block's signature; sending those on would be a
            // stream of empty events for the panel to learn to ignore.
            if (part.text) {
              yield this.sse(SSEEventType.AGENT_THINKING, {
                text: part.text,
                blockId: part.id,
              });
            }
            break;

          case "finish-step":
            tokensUsed += part.usage?.totalTokens ?? 0;
            if (stopAfterStep) break stream;
            break;

          // The SDK does not throw when the provider fails -- it hands the
          // failure back as a value and closes the stream. Measured on
          // ai@7.0.58 with a model whose `doStream` throws: the loop saw
          // ["start","error"] and did not throw. So an expired key, a 429 past
          // the retry budget and a bad model id all arrive here, and the
          // `catch` below never sees any of them.
          case "error":
            announced = "failed";
            yield this.failed(part.error);
            break stream;

          // A stop arrives the same way, as a part on the stream rather than
          // as an exception. Measured on ai@7.0.58: once the signal is raised
          // the SDK emits this, makes no further model call, and delivers no
          // tool-result or tool-error for whatever was in flight -- so this is
          // the last thing the loop will ever see, and reading it is the only
          // way the turn learns it was stopped.
          case "abort":
            announced = "aborted";
            break stream;

          case "tool-call":
            // Whatever was being written stops here, so the reply records
            // that the tool ran at this point and not somewhere else.
            flushPending();
            replyParts.push({
              type: "tool",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input as Record<string, unknown>,
              status: "pending",
            });
            yield this.sse(SSEEventType.AGENT_TOOL_HINT, { hint: part.toolName });
            break;

          case "tool-result": {
            // Stringify once; the same value is read for the marker, for the
            // event payload, and for what gets stored.
            const output = "output" in part ? part.output : undefined;
            const resultStr = typeof output === "string" ? output : JSON.stringify(output);

            const interaction = parseInteractionSentinel(resultStr);

            // The call this answers is already in the reply, waiting. Replace
            // it rather than mutate it in place, and store the result with its
            // marker off — that marker is read here and has no reader after.
            const callIndex = replyParts.findIndex(
              (p) => p.type === "tool" && p.toolCallId === part.toolCallId,
            );
            const call = callIndex >= 0 ? replyParts[callIndex] : undefined;
            if (call?.type === "tool") {
              replyParts[callIndex] = {
                ...call,
                status: "success",
                output: stripSentinel(resultStr),
              };
            }

            if (resultStr.startsWith(ASK_USER_SENTINEL)) {
              try {
                const payload = JSON.parse(resultStr.slice(ASK_USER_SENTINEL.length)) as Record<string, unknown>;
                yield this.sse(SSEEventType.AGENT_ASK, payload);
              } catch {
                yield this.sse(SSEEventType.AGENT_ASK, { question: resultStr });
              }
              // The turn stops here waiting for the user, but it still owes
              // an ending, and it owes the charge for the step it just ran.
              // So it leaves at this step's `finish-step` rather than here.
              announced = "blocked";
              stopAfterStep = true;
              break;
            }

            if (interaction) {
              yield this.sse(interaction.event, interaction.payload);
              // Only the tools that asked the user something stop here. The
              // ones that merely drew a card let the model write on around
              // them, and let it draw more than one in a turn.
              if (interaction.blocking) {
                announced = "blocked";
                stopAfterStep = true;
              }
            }
            break;
          }
        }
      }
      // Reached by the stream running out and by all three `break`s, so it
      // must not overwrite what a `break` just recorded -- assigning here is
      // for the one arrival that has nothing to say for itself.
      announced ??= "completed";
    } catch (err) {
      // The other failure shape: our own code inside the loop threw, or the
      // stream was torn down with `controller.error()`. A failing provider
      // does not land here -- see `case "error"` above.
      announced = "failed";
      yield this.failed(err);
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

      // Nothing announced means no line in the loop ran on the way out, which
      // happens for exactly one ending: the consumer walked away and resumed
      // this generator with `.return()`.
      const exit = announced ?? "aborted";
      const stopped = exit === "aborted";

      // Close off whatever the loop was in the middle of writing, then record
      // how it ended. Both have to happen before the reply is handed over:
      // this is the only point that knows the turn is over, and every ending
      // arrives here, including the one where nobody is listening any more.
      flushPending();
      if (stopped) replyParts.push({ type: "interrupted" });

      const failures = await finalizeTurn({
        steps: {
          // Anything at all to record means a message. A stopped turn always
          // has something -- the mark above -- so it is stored whether or not
          // it got a word out: a turn stopped after a tool call and before any
          // prose would otherwise leave no trace, and coming back to the
          // conversation would show no sign it had ever happened.
          persist:
            replyParts.length > 0
              ? async () => {
                  await messageRepo.addMessage(conversationId, {
                    role: "assistant",
                    parts: replyParts,
                  });
                }
              : undefined,
          bill: async () => {
            if (tokensUsed === 0) return;

            creditsUsed = Math.ceil((tokensUsed / 1000) * env.CREDIT_MULTIPLIER);
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
      //
      // A stop is told apart by a field on this event rather than by an event
      // of its own, so there stays exactly one ending to handle. A second
      // terminal event would be a second place for a client to forget, and
      // forgetting it looks like a turn that never ends.
      yield this.sse(SSEEventType.CHAT_DONE, {
        conversationId,
        creditsUsed,
        ...(stopped ? { aborted: true } : {}),
      });
    }
  }

  /**
   * Log a turn that failed and produce the event its client gets.
   *
   * Written once because a turn can fail two ways that look nothing alike --
   * a provider failure arrives as a value in the stream, our own code throws
   * -- and both owe the user the same thing. The message is deliberately not
   * the provider's: those carry endpoint URLs and key hints.
   * @param err - Whatever failed, for the log.
   * @returns The error event to send the client.
   */
  private failed(err: unknown): SSEEvent {
    const { userId, conversationId } = this.ctx;
    logger.error({ err, userId, conversationId }, "agent_turn_failed");
    return this.sse(SSEEventType.ERROR, {
      message: "The assistant could not finish this turn.",
    });
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
