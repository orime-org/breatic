// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Main Agent — streaming chat with AI SDK.
 *
 * Replaces the Python ToolCallRunner with AI SDK's built-in
 * `streamText()`, whose tool-call loop is bounded by `stopWhen`.
 */

import { createUIMessageStream, hasToolCall, stepCountIs } from "ai";
import { streamTextRetry } from "@breatic/domain";
import type { ModelMessage, StopCondition, ToolSet, UIMessageChunk } from "ai";

import { getModel, resolveProvider } from "@breatic/domain";
import { buildAgentConfig, finalizeTurn, STOPPED_BY_USER, TOOLS_THAT_BLOCK } from "@breatic/domain";
import type { ResolvedAgentConfig } from "@breatic/domain";
import { buildSystemPrompt } from "@server/agent/context.js";
import { reasoningOptionsFor } from "@server/agent/reasoning-options.js";
import { getAgentConfig } from "@breatic/core";
import { env } from "@breatic/core";
import { creditService } from "@breatic/domain";
import { buildTurnContext } from "@server/agent/turn-context.js";
import type { MessagePart, ToolFailure } from "@breatic/shared";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import { toStoredParts } from "@server/modules/conversation/message-part-mapping.js";
import * as conversationService from "@server/modules/conversation/conversation.service.js";
import { consolidateIfNeeded } from "@server/agent/memory-consolidator.js";
import { getContext } from "@breatic/core";
import { logger } from "@breatic/core";
import { toModelMessages } from "@server/agent/model-messages.js";
import { endingOf, TURN_ENDED_AROUND_IT } from "@server/agent/tool-ending.js";

/**
 * What a client is told when the turn's own code fails.
 *
 * Deliberately not the underlying message: provider failures carry endpoint
 * URLs and key hints, and ours carry file paths.
 */
const FAILED_TEXT = "The assistant could not finish this turn.";

/**
 * Main Agent for streaming chat interactions.
 *
 * Reads who is speaking and where -- userId, conversationId, projectId -- from
 * the AsyncLocalStorage request context (set by the route handler). What the
 * turn runs against is not in there: the memories and the compressed history
 * are read here, after the turn has said what it holds, because they are this
 * turn's own working rather than anything about the request.
 */
export class MainAgent {
  /**
   * The current request-scoped store (userId, conversationId, projectId) from
   * AsyncLocalStorage.
   * @returns The active request context for this agent turn.
   */
  private get ctx(): ReturnType<typeof getContext> {
    return getContext();
  }

  /**
   * Run a streaming chat turn with the user.
   * @param userMessage - The user's text message
   * @param signal - Raised when the user stops the turn or the client goes
   *   away. Absent means this caller has no way to stop the turn.
   * @returns The turn, as the SDK's own message chunks.
   */
  async chat(
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<UIMessageChunk>> {
    return this.runTurn(userMessage, signal);
  }

  /**
   * Execute a skill command (e.g. `/skill generate_image_plan ...`).
   * @param skillName - Name of the skill to invoke
   * @param userInput - User's input text for the skill
   * @param signal - Raised when the user stops the turn or the client goes
   *   away. Absent means this caller has no way to stop the turn.
   * @returns The turn, as the SDK's own message chunks.
   */
  async handleSkillCommand(
    skillName: string,
    userInput: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<UIMessageChunk>> {
    // Whether the skill exists is not asked here. `assertSkillUsable` on
    // the route has already answered it — with a 404 the client can act on,
    // before a message was saved or a stream opened. Asking again would be a
    // second answer to a settled question, which is how the two entry points
    // drifted apart in the first place.
    return this.runTurn(`/skill ${skillName} ${userInput}`, signal, skillName);
  }

  /**
   * Everything a turn does before the model is called, for either entry point.
   *
   * Both ways in — a message and a skill command — save what the user said,
   * assemble the same config and the same history, and hand off to the same
   * loop. They differ in one word: which skill, if any, scopes the tools.
   *
   * This exists as one function because the two used to be one copy each, and
   * that is exactly how the prompt assembly drifted into the bug this batch
   * fixed (task #75): a line changed on one side and not the other, with
   * nothing to say so.
   * @param said - What to record and send as the user's turn
   * @param signal - Raised when the user stops the turn or the client leaves
   * @param skillName - The skill scoping this turn, when it is a command
   * @returns The turn, as the SDK's own message chunks.
   */
  private async runTurn(
    said: string,
    signal: AbortSignal | undefined,
    skillName?: string,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { conversationId } = this.ctx;

    // Save what the user said. The turn it opened is what the rest of this
    // run is filed under: the reply goes in it, and billing builds a stable
    // refKey from it (`turn:${conversationId}:${turnIndex}`) that survives
    // retries — see domain/src/credit/credit.service.ts `deductOnce`.
    const turnIndex = await messageRepo.addMessage(conversationId, {
      role: "user",
      parts: [{ type: "text", text: said }],
    });

    // A conversation takes its name from the first thing said in it, so this
    // is the moment it gets one -- after the write above, which is what there
    // is to name it after. Sent on the stream rather than left for the client
    // to work out: the list and the header are showing a placeholder right
    // now, and nothing else would ever correct them.
    const title = await conversationService.titleForTurn(conversationId, said);

    // Everything slow happens inside the stream, not before it. The three
    // round trips for memory, the conversation and its history, and then the
    // compression, all used to run before the stream was even opened -- so
    // nothing of the turn could reach the reader until they were done, the
    // first word of the reply included, which is the one thing they were
    // waiting for.
    return this.runStream(said, turnIndex, title, signal, skillName);
  }

  /**
   * The turn, as a stream of the SDK's own message chunks.
   *
   * What used to be a loop translating each model part into an event of our
   * own is now two things: the SDK's stream merged in as it is, and the
   * turn's obligations settled once at the end. The protocol carries text,
   * reasoning and every state of a tool call without us naming any of them,
   * which is the whole reason for the move -- a tool's arguments and its
   * result reach the client because the protocol has a place for them, not
   * because we remembered to forward them.
   *
   * The obligations are unchanged and all of them live in `onFinish`: the
   * reply is written down, the tokens are charged for, memories are
   * consolidated, and one line says how it went. That callback runs when the
   * stream ends *and* when a reader lets go of it -- the SDK attaches it to
   * both `flush` and `cancel` -- so a closed page still closes the books.
   * Assembling what the model is asked happens inside `execute`, not before
   * the stream is built. Everything it takes -- three round trips for memory,
   * the conversation and its history, then the compression -- is time the
   * reader spends in front of a screen where nothing has happened, and a
   * stream that exists already has somewhere to put the name in the meantime.
   * @param said - What the user said, put in front of the model on its own.
   * @param turnIndex - The turn this run answers. A parameter and not a
   *   context field: it is known one line before the call, both the reply and
   *   the charge are filed under it, and neither has anything sensible to do
   *   with a turn it could not identify.
   * @param title - What the conversation is called now, or null when there was
   *   nothing to name it after. An already-named conversation answers with
   *   the name it has (`conversation.service.ts` returns it rather than
   *   null), so this is sent on every turn and the client writes down the
   *   same name again -- which is what keeps the list and the header from
   *   showing a placeholder after the turn that named it.
   * @param signal - Raised when the user stops the turn or the client goes away.
   * @param skillName - The skill scoping this turn, when it is a command.
   * @returns The turn's chunks, in the SDK's own protocol.
   */
  private runStream(
    said: string,
    turnIndex: number,
    title: string | null,
    signal?: AbortSignal,
    skillName?: string,
  ): ReadableStream<UIMessageChunk> {
    const { userId, conversationId, projectId } = this.ctx;
    const agentCfg = getAgentConfig();

    // What the turn ended up running on, for the charge at the end. Settled
    // inside `execute`, which is where the config is assembled.
    let modelId = "";

    // Whether this turn ended by putting a question to the reader.
    //
    // Written by the stop condition below, because that is the only place
    // that knows. Asking the reader something and running out of steps both
    // end as `stopWhen` firing, and the SDK reports the same `finishReason`
    // for either -- so a turn waiting on an answer and a turn that hit its
    // ceiling are indistinguishable from the outside.
    let askedTheUser = false;

    /**
     * Stop after a step that asked the reader something, and record that it
     * did.
     * @param options - The steps so far, from the SDK.
     * @param options.steps - Every step this turn has completed.
     * @returns Whether the turn should stop here.
     */
    const stopIfItAsked = async (options: {
      steps: Parameters<StopCondition<ToolSet>>[0]["steps"];
    }): Promise<boolean> => {
      const asked = await hasToolCall(...TOOLS_THAT_BLOCK)(options);
      if (asked) askedTheUser = true;
      return asked;
    };

    // Counted off each step as it finishes, never from `result.usage`. That
    // getter is not a passive read: it returns `totalUsage`, which calls
    // `consumeStream()`. On the exit that matters most -- the reader closing
    // the page while the model loop is still mid-flight -- reading it would
    // drive the rest of that loop after everyone has gone, running real
    // provider calls and real tool calls nobody asked for, then bill for
    // them. Every step says what it spent as it finishes, which gives the
    // same figure with none of that, on every exit alike.
    let tokensUsed = 0;

    // The SDK does not throw when the provider fails. It puts an `error`
    // chunk on the stream and closes it normally, so nothing rejects and
    // nothing is there to catch: an expired key, a 429 past the retry budget
    // and a bad model id all end a turn that, read from the outside, looks
    // like one that finished. The chunk is what says otherwise, and the
    // stream's `onError` below is handed it -- so that one callback covers
    // both a provider that failed and our own code throwing.
    let failure: unknown;

    // How each tool call that came back with nothing ended, by call id.
    //
    // Kept because the protocol does not carry it: the SDK replaces every
    // error text on the wire with one generic line, deliberately, since the
    // same channel also carries provider failures that name endpoints and
    // hint at keys. That is the right call for the wire and the wrong one for
    // the record -- a stored "An error occurred." is what the model reads
    // back next turn, so it cannot tell a refused connection from a bad
    // argument and cannot do anything differently. This callback is handed
    // the error itself, before any of that.
    const howToolEnded = new Map<string, ToolFailure>();

    /**
     * Ask the model, once everything it needs has been read.
     * @returns The model's answer, as the stream the protocol is made of.
     */
    const askTheModel = async (): Promise<ReadableStream<UIMessageChunk>> => {
      // The running turn is left out of the history on purpose. Its message
      // is put in front of the model separately, below, so a copy in the
      // history would be the same question asked twice -- and it would be a
      // candidate for compression, which could shorten the very thing being
      // asked.
      const { memoryContext, compressedHistory } = await buildTurnContext(
        userId,
        conversationId,
        projectId,
        turnIndex,
      );

      // One factory decides model, instructions and tools — see
      // domain/agent/agent-config.ts for why nothing else may assemble them.
      const agentConfig: ResolvedAgentConfig = buildAgentConfig({
        ...(skillName !== undefined ? { skillName } : {}),
        basePrompt: buildSystemPrompt(),
        memoryContext,
        interactive: true,
      });
      modelId = agentConfig.modelId;

      const messages: ModelMessage[] = [
        ...toModelMessages(compressedHistory),
        { role: "user", content: said },
      ];

      const result = streamTextRetry({
        model: getModel(agentConfig.modelId),
        system: agentConfig.instructions,
        messages,
        tools: agentConfig.tools,
        stopWhen: [stepCountIs(agentCfg.max_tool_iterations), stopIfItAsked],
        temperature: 0.2,
        // The middle ring of the stop chain. Without it the route can notice
        // the client leaving and the end of the stream can settle up, and the
        // model keeps running regardless: a signal handed in here ends the
        // stream within milliseconds, makes no further model call, and is
        // passed on to every tool the turn invokes.
        abortSignal: signal,
        onStepFinish: ({ usage, content }) => {
          tokensUsed += usage?.totalTokens ?? 0;
          // The other way a call can fail, and the only place its reason is
          // readable. A call whose arguments the model shaped wrongly is
          // refused at the door -- the SDK never runs it, so the callback
          // below never fires -- and on the wire its reason is replaced with
          // one masked line. Here it is still the error itself, saying which
          // field failed which rule, which is exactly what the model needs to
          // send the call again correctly.
          for (const part of content) {
            if (part.type !== "tool-error") continue;
            if (howToolEnded.has(part.toolCallId)) continue;
            howToolEnded.set(part.toolCallId, endingOf(part.error));
          }
        },
        onToolExecutionEnd: ({ toolCall, toolOutput }) => {
          if (toolOutput.type !== "tool-error") return;
          howToolEnded.set(toolCall.toolCallId, endingOf(toolOutput.error));
        },
        // Deliberately does nothing. The same failure reaches the end of the
        // stream as an error chunk and is recorded there, alongside the ones
        // our own code throws; recording it twice would put two lines in the
        // log for one failed turn. What this is for is the default it
        // replaces, which writes the provider's error -- endpoint and key
        // hints included -- straight to the console, around our logger.
        onError: () => undefined,
        ...reasoningOptionsFor(resolveProvider(agentConfig.modelId), agentCfg.thinking_enabled),
      });

      return result.toUIMessageStream();
    };

    return createUIMessageStream({
      execute: async ({ writer }) => {
        // A conversation is named after the first thing said in it, and the
        // name is settled before the model is asked anything. Written ahead
        // of everything below so the panel and the list stop showing a
        // placeholder while the rest of this is still going on.
        if (title !== null) {
          writer.write({ type: "data-conversation-titled", data: { title } });
        }
        writer.merge(await askTheModel());
      },
      // The one place a failed turn is noticed, whichever way it failed: the
      // SDK hands this callback both an error chunk arriving on the stream
      // (which is how a provider failure gets here) and anything the turn's
      // own code throws. Without it the line at the end reports a turn that
      // finished.
      onError: (err) => {
        failure = err;
        this.logFailure(err);
        return FAILED_TEXT;
      },
      onFinish: async ({ responseMessage, isAborted }) => {
        // Nobody is waiting for consolidation -- the reader is waiting for
        // the turn to be over. Started rather than awaited so it stays out
        // from in front of the ending, and started here so a disconnect
        // still triggers it. Its failure is logged here because it has
        // nobody left to return to.
        void consolidateIfNeeded(userId, conversationId, projectId).catch((err: unknown) =>
          logger.warn({ err, userId, conversationId }, "memory_consolidation_failed"),
        );

        const exit = isAborted
          ? "aborted"
          : failure !== undefined
            ? "failed"
            : askedTheUser
              ? "blocked"
              : "completed";

        const replyParts = toStoredParts(responseMessage.parts);

        // Both marks are recorded rather than left to be inferred: without
        // them a stopped turn and a failed one read back as a turn that
        // simply had little to say, and a reload would show either as a
        // finished answer.
        if (exit === "aborted") replyParts.push({ type: "interrupted" });
        if (exit === "failed") replyParts.push({ type: "failed" });

        // Put the reasons back. What came off the wire says only that
        // something went wrong, and that sentence is what the model would
        // read back next turn -- see `howToolEnded`.
        for (const [i, part] of replyParts.entries()) {
          if (part.type !== "tool" || part.status !== "error") continue;
          const ending = howToolEnded.get(part.toolCallId);
          if (ending !== undefined) replyParts[i] = { ...part, failure: ending };
        }

        // A stored message is a record of something that already happened,
        // so nothing in it may still say "running". A call in flight when
        // the turn ended never gets a result, and there is no later moment
        // that would close it out.
        //
        // Why it ended is what `exit` says, and it has to be asked: a call
        // left hanging by a provider that dropped mid-step looks exactly
        // like one left hanging by the user pressing stop, and recording
        // the second as the first tells the next turn the user did
        // something they never did.
        const leftHanging: ToolFailure =
          exit === "aborted" ? STOPPED_BY_USER : TURN_ENDED_AROUND_IT;
        for (const [i, part] of replyParts.entries()) {
          if (part.type === "tool" && part.status === "pending") {
            replyParts[i] = { ...part, status: "error", failure: leftHanging };
          }
        }

        let creditsUsed = 0;
        const failures = await finalizeTurn({
          steps: {
            // Anything at all to record means a message. A stopped turn
            // always has something -- the mark above -- so it is stored
            // whether or not it got a word out: a turn stopped after a tool
            // call and before any prose would otherwise leave no trace, and
            // coming back to the conversation would show no sign it had ever
            // happened.
            persist:
              replyParts.length > 0
                ? async () => {
                    await messageRepo.addMessage(conversationId, {
                      role: "assistant",
                      parts: replyParts,
                      turnIndex,
                    });
                  }
                : undefined,
            bill: async () => {
              if (tokensUsed === 0) return;

              creditsUsed = Math.ceil((tokensUsed / 1000) * env.CREDIT_MULTIPLIER);
              // The turn-scoped refKey makes this idempotent: a reconnect or
              // a re-entry on the same turn will not double-charge.
              await creditService.deductOnce(
                userId,
                `turn:${conversationId}:${turnIndex}`,
                creditsUsed,
                "Agent chat",
                {
                  tokensUsed,
                  model: modelId,
                  provider: resolveProvider(modelId),
                },
              );
            },
          },
        });

        // The finalizer does not log -- it is in domain, which has no
        // logger. This is the layer that knows the user and the
        // conversation.
        for (const stepFailure of failures) {
          logger.error(
            { err: stepFailure.error, userId, conversationId, step: stepFailure.step },
            "turn_finalizer_step_failed",
          );
        }

        logger.info(
          {
            userId,
            conversationId,
            // Which model answered. The config says what was asked for; only
            // this says what ran, and a deployment that moved to another
            // model has nothing else to read.
            modelId,
            responseLength: this.proseLengthOf(replyParts),
            creditsUsed,
            exit,
          },
          "agent_response",
        );
      },
    });
  }

  /**
   * How much prose a turn produced, for the line that records it.
   * @param parts - What the turn wrote down.
   * @returns The number of characters of prose in it.
   */
  private proseLengthOf(parts: MessagePart[]): number {
    return parts.reduce((n, part) => (part.type === "text" ? n + part.text.length : n), 0);
  }

  /**
   * Record a turn that failed, whichever of the two ways it failed.
   *
   * A turn fails in two places that look nothing alike -- the provider hands
   * a value to the model stream's `onError`, our own code throws -- and both
   * owe an on-call reader the same line.
   * @param err - Whatever failed.
   */
  private logFailure(err: unknown): void {
    const { userId, conversationId } = this.ctx;
    logger.error({ err, userId, conversationId }, "agent_turn_failed");
  }
}
