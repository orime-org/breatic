// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Main Agent — streaming chat with AI SDK.
 *
 * Replaces the Python ToolCallRunner with AI SDK's built-in
 * `streamText()`, whose tool-call loop is bounded by `stopWhen`.
 */

import { createUIMessageStream, stepCountIs } from "ai";
import { streamTextRetry } from "@breatic/domain";
import type { ModelMessage, Tool, ToolSet, UIMessage, UIMessageChunk, UIMessageStreamWriter } from "ai";

import { callOptionsFor, getModel, resolveProvider, systemFor } from "@breatic/domain";
import {
  buildAgentConfig,
  finalizeTurn,
  ASK_USER,
} from "@breatic/domain";
import type { OpenDocument, ResolvedAgentConfig } from "@breatic/domain";
import { buildSystemPrompt } from "@server/agent/context.js";
import { readerClockNote } from "@server/agent/reader-clock.js";
import { getAgentConfig, getStorageAdapter } from "@breatic/core";
import { assetService, creditLotService, createUsageRecorder } from "@breatic/domain";
import { saveToStorageFor } from "@server/agent/save-to-storage.js";
import { openDocumentOf, turnToolsContext } from "@server/agent/turn-tools-context.js";
import { buildTurnContext } from "@server/agent/turn-context.js";
import { watchModelCalls, type ModelCallWatch } from "@server/agent/model-call-watch.js";
import type { AskUserResult, ChatAttachedChip, ChatSpaceContext, ConsentSnapshot, MessagePart, ToolFailure } from "@breatic/shared";
import { toolFailureOf, wireLineOf, wordsForTitle } from "@breatic/shared";
import { continuationMessageForModel, openSpaceKey, userMessageForModel } from "@server/agent/user-turn.js";
import type { UserTurn } from "@server/agent/user-turn.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import { toStoredParts } from "@server/modules/conversation/message-part-mapping.js";
import * as conversationService from "@server/modules/conversation/conversation.service.js";
import { foldIfOverBudget } from "@server/agent/turn-budget.js";
import { requestTokens } from "@server/agent/request-size.js";
import type { Assembly } from "@server/agent/turn-budget.js";
import { claimFirstMilestone, currentConsent, getContext, serverAnalyticsWanted, trackServerEvent } from "@breatic/core";
import { logger } from "@breatic/core";
import { lastFullSnapshotKey, prefixHash, replayRows } from "@server/agent/history-replay.js";
import type { ReplyForModel, UserForModel } from "@server/agent/history-replay.js";
import { endingNote } from "@server/agent/model-messages.js";
import { inProgressStep, noteUsage, replyTokens, type ReportedUsage, type SettledCalls } from "@server/agent/reply-for-model.js";
import { measureMessages } from "@server/agent/payload-size.js";
import { withModelOutputs } from "@server/agent/stored-model-output.js";
import { endingOf, endingWithNothingRun } from "@server/agent/tool-ending.js";
import { askResultForModel, SECOND_QUESTION_TURNED_AWAY, turnedAwayForModel } from "@server/agent/ask-result.js";

/**
 * What opened a segment of a turn: the reader's message, or the reader's
 * answer to a questionnaire the turn stopped at (inner#1542).
 */
type Opening =
  | {
      kind: "message";
      clockNote: string;
      turn: UserTurn;
      /** The questionnaires this message closed instead of answering them. */
      closedAsks: string[];
    }
  | {
      kind: "answer";
      clockNote: string;
      space: ChatSpaceContext;
      toolCallId: string;
      result: AskUserResult;
    };

/** What a waiting questionnaire is settled with when the reader writes a message instead. */
const REPLIED_IN_CHAT: AskUserResult = { repliedInChat: true };

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
 * turn runs against is not in there: the memories and the history
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
   * @param attached - What the user attached to the message, in order.
   * @param timeZone - The zone the reader's browser reported, if any.
   * @param space - The project's Spaces and the one the reader has open.
   * @returns The turn, as the SDK's own message chunks.
   */
  async chat(
    userMessage: string,
    signal?: AbortSignal,
    attached: readonly ChatAttachedChip[] = [],
    timeZone?: string,
    space: ChatSpaceContext = {},
  ): Promise<ReadableStream<UIMessageChunk>> {
    return this.runTurn(userMessage, attached, signal, timeZone, space);
  }

  /**
   * Everything a turn does before the model is called.
   * @param said - What the user typed
   * @param attached - What the user attached, stored beside the typed words
   * @param signal - Raised when the user stops the turn or the client leaves
   * @param timeZone - The zone the reader's browser reported, if any
   * @param space - The project's Spaces and the one the reader has open
   * @returns The turn, as the SDK's own message chunks.
   */
  private async runTurn(
    said: string,
    attached: readonly ChatAttachedChip[],
    signal: AbortSignal | undefined,
    timeZone: string | undefined,
    space: ChatSpaceContext,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { conversationId } = this.ctx;

    // Save what the user said. The turn it opened is what the rest of this
    // run is filed under: the reply goes in it, and billing builds a stable
    // refKey from it (`turn:${conversationId}:${turnIndex}`) that survives
    // retries — see domain/src/credit/creditLot.service.ts
    // `chargeOnceForGeneration`.
    //
    // Every questionnaire still waiting is closed by this message, in the
    // same transaction: its result says the reader wrote a message instead,
    // and is kept beside the call in the row that asked.
    const { turnIndex, closedAsks } = await messageRepo.addReaderMessage(
      conversationId,
      {
        role: "user",
        parts: [
          ...attached.map((chip): MessagePart => ({ type: "attachment", chip })),
          { type: "text", text: said },
        ],
      },
      (toolCallId) => ({ output: REPLIED_IN_CHAT, forModel: askResultForModel(toolCallId, REPLIED_IN_CHAT) }),
    );

    // A conversation takes its name from the first thing said in it, so this
    // is the moment it gets one -- after the write above, which is what there
    // is to name it after. Sent on the stream rather than left for the client
    // to work out: the list and the header are showing a placeholder right
    // now, and nothing else would ever correct them.
    const title = await conversationService.titleForTurn(
      conversationId,
      wordsForTitle(attached, said),
    );

    // Everything slow happens inside the stream, not before it. The three
    // round trips for memory, the conversation and its history all used to
    // run before the stream was even opened -- so
    // nothing of the turn could reach the reader until they were done, the
    // first word of the reply included, which is the one thing they were
    // waiting for.
    //
    // The reader's clock opens this turn's message, on its own line, ahead of
    // any attached content, so it never sits under the "User message"
    // heading. The system prompt does not carry it. The reader's Spaces
    // follow it, read fresh with each message. The message is kept as it was
    // sent and later turns send it again as it is, so a provider's prefix
    // cache matches everything up to the new message.
    const opening: Opening = {
      kind: "message",
      clockNote: readerClockNote(new Date(), timeZone),
      turn: { ...space, chips: attached, message: said },
      closedAsks,
    };
    return this.runStream(opening, turnIndex, title, openDocumentOf(space), signal);
  }

  /**
   * Resume a turn that stopped at a questionnaire, once the reader's answer
   * has been taken (inner#1542).
   *
   * The answer is already in the store -- the route settled it before calling
   * this -- so what runs here is the turn's next segment: the paused turn as
   * history, the answer as the call's result, and the model asked again.
   * @param toolCallId - The questionnaire call answered.
   * @param result - What it was answered with.
   * @param turnIndex - The turn that asked.
   * @param signal - Raised when the user stops the turn or the client goes away.
   * @param timeZone - The zone the reader's browser reported, if any.
   * @param space - The project's Spaces and the one the reader has open.
   * @returns The segment, as the SDK's own message chunks.
   */
  async answer(
    toolCallId: string,
    result: AskUserResult,
    turnIndex: number,
    signal?: AbortSignal,
    timeZone?: string,
    space: ChatSpaceContext = {},
  ): Promise<ReadableStream<UIMessageChunk>> {
    const opening: Opening = {
      kind: "answer",
      clockNote: readerClockNote(new Date(), timeZone),
      space,
      toolCallId,
      result,
    };
    return this.runStream(opening, turnIndex, null, openDocumentOf(space), signal);
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
   * What the turn owes at the end lives in `onFinish`: the reply is written
   * down, the tokens are charged for, and one line says how it went. That
   * callback runs when the stream ends *and* when a reader lets go of it --
   * the SDK attaches it to both `flush` and `cancel` -- so a closed page
   * still closes the books. Folding memory is not among them: it belongs in
   * front of the reply, on the turn whose assembled request it can shorten.
   * Assembling what the model is asked happens inside `execute`, not before
   * the stream is built. Everything it takes -- the two memory reads,
   * the conversation and its history -- is time the
   * reader spends in front of a screen where nothing has happened, and a
   * stream that exists already has somewhere to put the name in the meantime.
   * @param opening - What opened this segment: the reader's message (the
   *   clock, Spaces, attachments and typed words, laid out with each assembly,
   *   which knows whether the history already holds the open Space), or the
   *   reader's answer to the questionnaire the turn stopped at.
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
   * @param openDocument - The document the reader has open, which a document
   *   proposal goes to, or null when none can be read.
   * @param signal - Raised when the user stops the turn or the client goes away.
   * @returns The turn's chunks, in the SDK's own protocol.
   */
  private runStream(
    opening: Opening,
    turnIndex: number,
    title: string | null,
    openDocument: OpenDocument | null,
    signal?: AbortSignal,
  ): ReadableStream<UIMessageChunk> {
    const { userId, conversationId, projectId } = this.ctx;
    const agentCfg = getAgentConfig();
    // The asking browser's choice, held for the end of the turn, which can
    // run after the request that started it has returned.
    const consent = currentConsent();
    let turnStudioId = "";

    // What the turn ended up running on, for the charge at the end. Settled
    // inside `execute`, which is where the config is assembled.
    let modelId = "";
    // The tool set the model ran with, for writing down what each call gave
    // it. Settled with `modelId`, after any fold, so it is the set of the call
    // that produced the reply.
    let turnTools: Readonly<Record<string, Tool>> = {};

    // The questionnaire this segment stopped at, if it did, and the ones put
    // in the same step after it. Decided when the model's stream finishes:
    // `ask_user` has no `execute`, so the SDK stops the step at it and never
    // consults `stopWhen` (`ai@7.0.68` `dist/index.js:10046-10053`).
    let awaitingCall: string | undefined;
    let turnedAwayCalls: string[] = [];
    // Media a questionnaire may show: what `search_images` returned in this
    // conversation, read from the history and added to as this turn searches.
    const vouchedMedia = new Set<string>();
    /** Where the stretch of thinking now open began, if one is. */
    let thinkingOpenedAt: number | undefined;
    /** How long the turn has thought so far, summed over closed stretches. */
    let thoughtForMs = 0;
    /** Count the stretch now open, if one is, and leave none open. */
    const closeThinking = (): void => {
      if (thinkingOpenedAt === undefined) return;
      thoughtForMs += Date.now() - thinkingOpenedAt;
      thinkingOpenedAt = undefined;
    };

    // Every paid call this turn makes is recorded where it happens, one row
    // each (#296); the turn is charged what those rows add up to. Model calls
    // are recorded as each one's response arrives, never from `result.usage`:
    // that getter calls `consumeStream()`, and on the exit that matters most --
    // the reader leaving mid-loop -- reading it would drive the rest of the
    // loop after everyone has gone.
    const usage = createUsageRecorder({
      // A segment resumed after a questionnaire is charged on its own: the
      // charge below is taken once per key, and the segment that asked has
      // already settled under the turn's.
      operationKey:
        opening.kind === "answer"
          ? `turn:${conversationId}:${String(turnIndex)}:answer:${opening.toolCallId}`
          : `turn:${conversationId}:${String(turnIndex)}`,
      feature: "chat_turn",
      actorUserId: userId,
      projectId,
      onMissingCost: (row) =>
        logger.error({ row, userId, conversationId }, "agent_usage_cost_missing"),
    });
    // Set once the model is known; records the turn's model calls.
    let calls: ModelCallWatch | undefined;

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
    /** What a tool answered, for calls whose result chunk never got read. */
    const whatToolAnswered = new Map<string, unknown>();

    // What the reply row keeps of what was sent (`for_model`). Each finished
    // step's messages, in order; a step went out as it is once a later request
    // carried it. The hash is of the request the turn's first call sent; the
    // provider's counts size the turn for the fold.
    const steps: ModelMessage[][] = [];
    // True while the last finished step ended on a provider error and no later
    // request has started: that step is partial and went nowhere.
    let lastStepUnsent = false;
    let reported: ReportedUsage = {};
    // The assembly the turn's first call sent, once the model has been asked.
    let sent: Assembly | undefined;

    /**
     * What the reply row keeps of what was sent: the finished steps, the step
     * the turn ended inside, and a note when it did not end on its own.
     * @param ended - How the turn ended and what it left behind.
     * @param ended.exit - How the turn ended.
     * @param ended.stored - The reply's parts as they are stored, which say how
     *   the turn ended.
     * @param ended.parts - The reply's parts, as the reader received them.
     * @param ended.tools - The turn's tools.
     * @param ended.settled - How the turn's calls ended.
     * @returns The copy, or undefined when the model was never asked.
     * @throws {never} Never; a step that cannot be rebuilt is left out.
     */
    const keptOfReply = async (ended: {
      exit: "aborted" | "failed" | "blocked" | "completed";
      stored: readonly MessagePart[];
      parts: UIMessage["parts"];
      tools: ToolSet;
      settled: SettledCalls;
    }): Promise<ReplyForModel | undefined> => {
      if (sent === undefined) return undefined;
      // A partial step nothing carried on is rebuilt from what reached the reader.
      const sentOn = lastStepUnsent ? steps.slice(0, -1) : steps;
      const collected = sentOn.flat();
      let unfinished: ModelMessage[] = [];
      if (ended.exit === "aborted" || ended.exit === "failed") {
        try {
          unfinished = await inProgressStep(ended.parts, sentOn.length, ended.tools, ended.settled, collected);
        } catch (err) {
          // Left out, the step reaches later turns only as the note below.
          logger.error({ err, userId, conversationId, projectId, turnIndex }, "turn_unfinished_step_unconvertible");
        }
      }
      // A segment paused at a questionnaire has not ended: its answer is
      // appended to this copy and must follow the call it answers.
      const note = ended.exit === "blocked" ? undefined : endingNote(ended.stored);
      // A resumed segment's own message is kept in its row, since no reader's
      // row holds it; its hash is of everything before that message, which is
      // what the next request will have sent ahead of this row.
      const own = opening.kind === "answer" ? sent.userKept.messages : [];
      const ahead = opening.kind === "answer" ? sent.messages.slice(0, -own.length) : sent.messages;
      const messages: ModelMessage[] = [
        ...own,
        ...collected,
        // Every call in a kept copy has its result: a second question turned
        // away in the step that stopped gets its refusal here.
        ...(ended.exit === "blocked" && turnedAwayCalls.length > 0 ? [turnedAwayForModel(turnedAwayCalls)] : []),
        ...unfinished,
        ...(note === undefined ? [] : [{ role: "assistant" as const, content: note }]),
      ];
      return {
        messages,
        prefixHash: prefixHash(sent.agentConfig, ahead),
        ...(opening.kind === "answer" && sent.userKept.snapshot !== undefined ? { snapshot: sent.userKept.snapshot } : {}),
        ...replyTokens(reported, {
          user: measureMessages(sent.userKept.messages),
          // A resumed segment's own message is the `user` above; counted once.
          reply: measureMessages(messages.slice(own.length)),
          request: requestTokens(sent),
        }),
      };
    };

    /**
     * Read everything the model is given, and lay it out as it will be sent.
     *
     * Repeatable on purpose: a consolidation changes both halves of what this
     * reads — the watermark shortens the history, the summary lands in memory
     * — so the turn runs it again afterwards rather than editing the first
     * result, which would leave the folded turns missing from both places.
     * @returns The request, and what it was built from.
     */
    const assemble = async (): Promise<Assembly> => {
      // The running turn is left out of the history on purpose. Its message
      // is put in front of the model separately, below, so a copy in the
      // history would be the same question asked twice.
      //
      // A resumed segment is the exception: the turn it resumes is its
      // history, the paused reply with the answer appended to it included.
      const { memoryContext, history, watermark } = await buildTurnContext(
        userId,
        conversationId,
        projectId,
        opening.kind === "answer" ? turnIndex + 1 : turnIndex,
      );

      for (const row of history) {
        for (const part of row.parts) {
          if (part.type === "tool" && part.toolName === "search_images" && part.status === "success") {
            for (const url of searchedPictures(part.output)) vouchedMedia.add(url);
          }
        }
      }
      const storage = await getStorageAdapter();

      // One factory decides model, instructions and tools — see
      // domain/agent/agent-config.ts for why nothing else may assemble them.
      const agentConfig: ResolvedAgentConfig = buildAgentConfig({
        basePrompt: buildSystemPrompt(),
        memoryContext,
        toolContext: { mediaUrlAllowed: (url) => storage.keyFromUrl(url) !== null || vouchedMedia.has(url) },
      });

      // The open Space goes as one line while it is what the history,
      // folded as it is now, last sent of it in full.
      const space = opening.kind === "message" ? opening.turn : opening.space;
      const open = openSpaceKey(space.current_space);
      const unchanged = open !== undefined && lastFullSnapshotKey(history, open.spaceId) === open.key;
      const userMessage: ModelMessage = {
        role: "user",
        content:
          opening.kind === "message"
            ? userMessageForModel(opening.clockNote, opening.turn, unchanged)
            : continuationMessageForModel(opening.clockNote, opening.space, unchanged),
      };
      const replayed = replayRows(history, agentConfig);
      // Kept as it is so what is stored is what went out.
      const userKept: UserForModel = {
        messages: [userMessage],
        ...(open === undefined ? {} : { snapshot: { ...open, full: !unchanged } }),
      };
      return {
        agentConfig,
        replayed,
        watermark,
        userKept,
        messages: [...replayed.flatMap((one) => one.messages), userMessage],
      };
    };

    /**
     * Ask the model, once everything it needs has been read.
     * @param writer - The stream, for the one thing that happens before the
     *   answer starts and is worth saying out loud.
     * @returns The model's answer, as the stream the protocol is made of.
     */
    const askTheModel = async (
      writer: UIMessageStreamWriter,
    ): Promise<ReadableStream<UIMessageChunk>> => {
      let assembly = await assemble();

      // Measured here rather than inside the assembly because this is where
      // the request is whole: the instructions carry the persona and the
      // memory, and the tool definitions reach the provider as an
      // argument of their own.
      // A resumed segment does not fold: it is in the middle of a tool round,
      // and a fold changes the memory in the instructions, after which the
      // paused reply would be sent again without its thinking. The fold waits
      // for the reader's next message, when the round is closed.
      if (
        opening.kind === "message" &&
        await foldIfOverBudget(assembly, {
          userId,
          conversationId,
          projectId,
          ...(signal ? { signal } : {}),
          // A fold is a model call of its own in front of the reply, seconds
          // long, on a turn where the panel is empty and somebody is watching
          // it. This does not make the wait shorter; it makes it explainable.
          onStart: () =>
            // Transient, like the heartbeat: it is a word about the turn,
            // not a piece of the answer, so it must not become a message
            // part or count as the turn having started to speak.
            writer.write({ type: "data-memory-consolidating", transient: true, data: {} }),
        })
      ) {
        try {
          assembly = await assemble();
        } catch (err) {
          // The fold moved the watermark, so the window is out of the history
          // whichever way it ended. Failing here would spend it and give the
          // reader nothing, and the reply is what was promised. What is still
          // in hand is the pre-fold assembly, over the token budget by
          // however much this conversation had grown: sending it is the one
          // move left that answers at all, and the provider is what decides
          // whether it fits.
          logger.error(
            { err, userId, conversationId, projectId },
            "turn_reassembly_failed",
          );
        }
      }

      const { agentConfig, messages } = assembly;
      modelId = agentConfig.modelId;
      sent = assembly;

      // Kept as it is about to go out, after any fold, so later turns send it
      // again as it is. Losing the copy costs this turn nothing: later turns
      // render the message from its parts the way they always did, so the
      // cache stops matching from this message on and this turn's reply goes
      // back without its thinking.
      // A resumed segment's own message is kept in its reply row instead: the
      // reader's row of this turn holds the message that opened it.
      if (opening.kind === "message") {
        try {
          await messageRepo.setUserForModel(conversationId, turnIndex, assembly.userKept);
        } catch (err) {
          logger.error({ err, userId, conversationId, projectId, turnIndex }, "turn_user_for_model_write_failed");
        }
      }
      turnTools = agentConfig.tools;
      // The studio whose material a proposal may name: the project's owner,
      // which is also where a saved picture is charged.
      const studioId = await assetService.resolveOwnerStudioId(projectId);
      turnStudioId = studioId;
      const watch = watchModelCalls(usage, {
        model: agentConfig.modelId,
        description: "Agent chat",
        cacheTtl: agentCfg.prompt_cache_ttl,
      });
      calls = watch;

      const result = streamTextRetry({
        model: getModel(agentConfig.modelId),
        // Chat is the one call site that asks for reasoning: it plans,
        // searches and decides between tools, and shows its working. It is
        // also the one whose prefix repeats -- every step of a turn and every
        // later turn resends it -- so it is the one that asks for caching.
        ...callOptionsFor(agentConfig.modelId, {
          thinking: true,
          cache: agentCfg.prompt_cache_ttl,
          session: conversationId,
        }),
        system: systemFor(agentConfig.modelId, agentConfig.instructions, agentCfg.prompt_cache_ttl),
        messages,
        tools: agentConfig.tools,
        // The paying tools record their calls on this turn's recorder, the
        // save stores for this project and reader, the canvas proposal check
        // reads material for this studio, and the document proposal checks
        // against the document the reader has open. Cast because the tool set arrives as
        // a plain record, whose context type the SDK reads as absent; each
        // tool's `contextSchema` is what checks this at run time, before its
        // `execute`.
        toolsContext: turnToolsContext(agentConfig.tools, usage, {
          saveToStorage: saveToStorageFor({ projectId, userId }),
          studioId,
          openDocument,
        }) as never,
        stopWhen: stepCountIs(agentCfg.max_tool_iterations),
        // Per call, which is the only unit there is: the `stopWhen` above
        // lets one turn make many, and each of them is bounded by this. An
        // answer with no ceiling is carried whole by every later turn's
        // history.
        maxOutputTokens: agentCfg.max_output_tokens,
        // The middle ring of the stop chain. Without it the route can notice
        // the client leaving and the end of the stream can settle up, and the
        // model keeps running regardless: a signal handed in here ends the
        // stream within milliseconds, makes no further model call, and is
        // passed on to every tool the turn invokes.
        abortSignal: signal,
        // How long the model thought, summed across the stretches it thought
        // in. The provider says when each one opens and closes, so this is
        // measured rather than inferred from what came after it -- the gap
        // between a stretch ending and the next part starting is a tool call
        // and a round trip, which is not thinking.
        includeRawChunks: watch.streamOptions.includeRawChunks,
        onChunk: ({ chunk }) => {
          watch.streamOptions.onChunk({ chunk });
          if (chunk.type === "reasoning-start") thinkingOpenedAt = Date.now();
          else if (chunk.type === "reasoning-end" && thinkingOpenedAt !== undefined) {
            thoughtForMs += Date.now() - thinkingOpenedAt;
            thinkingOpenedAt = undefined;
          } else if (chunk.type === "tool-error" && !howToolEnded.has(chunk.toolCallId)) {
            // Recorded as it arrives rather than at the end of the step. A
            // call whose arguments the model shaped wrongly is refused at the
            // door: the SDK never runs it, so `onToolExecutionEnd` never fires,
            // and a turn stopped before the step ends never reaches
            // `onStepFinish` -- left to that, the refusal would be stored as a
            // failure with nothing said why. What arrives is a string -- the
            // SDK renders the error with `toString()` -- reading
            // `AI_InvalidToolInputError: ...` with the schema complaint after
            // it, which is what the model needs to send the call again. First
            // account of a call wins, here and below, so which of the two ran
            // first stops mattering.
            howToolEnded.set(chunk.toolCallId, endingOf(chunk.error));
          }
        },
        // Fires when a model response is parsed, before the tools it asked
        // for run: a turn stopped while a tool is running has still paid for
        // the call that asked for it.
        onLanguageModelCallEnd: (event) => {
          watch.callEnded(event);
          reported = noteUsage(reported, event.usage);
        },
        // Fires as each request is about to go out, after the previous
        // step's onStepFinish: the request carries that step as it is.
        onStepStart: () => {
          lastStepUnsent = false;
        },
        onStepFinish: (step) => {
          steps.push(step.response.messages);
          lastStepUnsent = step.finishReason === "error";
        },
        onToolExecutionEnd: ({ toolCall, toolOutput }) => {
          // Both endings are kept, because the chunk carrying either one can
          // be thrown away before anything reads it: the SDK reports a tool
          // ending first and enqueues it after, and a turn that ends in
          // between loses what was enqueued. The part is then left saying the
          // call is still running, and the only account of it left anywhere
          // is this one.
          if (toolOutput.type === "tool-error") {
            if (howToolEnded.has(toolCall.toolCallId)) return;
            const ending = endingOf(toolOutput.error);
            howToolEnded.set(toolCall.toolCallId, ending);
            // The turn carries on and the model is told why; the error the
            // tool caught, and what caused it, are kept only in this log.
            // A call turned away to steer the model, or one the reader
            // stopped, is not a failure. A failure the tool described is one
            // it saw coming, and the reader was told: a warning. A throw it
            // did not describe is a fault in our own code: an error.
            if (ending.kind === "tool_failed") {
              const details = {
                err: toolOutput.error,
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                userId,
                conversationId,
                projectId,
                forModel: ending.forModel,
              };
              if (toolFailureOf(toolOutput.error) === undefined) {
                logger.error(details, "agent_tool_failed");
              } else {
                logger.warn(details, "agent_tool_failed");
              }
            }
            return;
          }
          whatToolAnswered.set(toolCall.toolCallId, toolOutput.output);
          // A picture found in this turn may be shown on a questionnaire the
          // model puts later in the same turn.
          if (toolCall.toolName === "search_images") {
            for (const url of searchedPictures(toolOutput.output)) vouchedMedia.add(url);
          }
        },
        // Deliberately does nothing. The same failure reaches the end of the
        // stream as an error chunk and is recorded there, alongside the ones
        // our own code throws; recording it twice would put two lines in the
        // log for one failed turn. What this is for is the default it
        // replaces, which writes the provider's error -- endpoint and key
        // hints included -- straight to the console, around our logger.
        onError: () => undefined,
        // Whether the model runs out of room is not ours to decide; whether
        // the reader is told it happened is. Said on the wire rather than
        // only in storage, because this is the one signal the browser cannot
        // work out for itself -- the same reason a failed turn puts its own
        // mark on the reply as it happens. The SDK turns the frame into a
        // part of the reply, which is what carries it into storage and back.
        onFinish: ({ finishReason, toolCalls }) => {
          if (finishReason === "length") {
            writer.write({ type: "data-truncated", data: {} });
          }
          // Said on the wire for the same reason as the two above: the SDK
          // turns the frame into a part of the reply, so the figure reaches
          // the reader as the turn ends. A turn that never gets here -- one
          // stopped mid-answer -- has the same figure written into its
          // stored parts at the exit below, which runs however it ended.
          closeThinking();
          if (thoughtForMs > 0) {
            writer.write({ type: "data-thinking-time", data: { ms: thoughtForMs } });
          }
          // The step stopped at a questionnaire when it holds an `ask_user`
          // call the schema took and nothing has answered. The first is the
          // card the reader is shown; any later one in the step is turned
          // away. Said on the wire here, while the writer is still open, so
          // the panel draws the card as waiting rather than as a call that
          // came to nothing -- the rule lives on this side only. Written last,
          // so it is the last part of the segment that asked: the browser
          // splits the reply there once the reader answers and the turn
          // resumes in the same message. A step that ended on an error is a
          // failed turn, stored with its calls as never run, so it names no
          // card.
          const asks =
            finishReason === "error"
              ? []
              : toolCalls
                .filter((call) => call.toolName === ASK_USER && call.invalid !== true && !howToolEnded.has(call.toolCallId))
                .map((call) => call.toolCallId);
          if (asks[0] !== undefined) {
            awaitingCall = asks[0];
            turnedAwayCalls = asks.slice(1);
            writer.write({ type: "data-ask-awaiting", data: { toolCallId: awaitingCall } });
          }
        },
      });

      // The one field the wire has for a failure, filled with the line a
      // reader is shown. Left to its default the SDK writes one fixed English
      // sentence here -- a default that exists so a server does not leak its
      // own error text, which a translation key does not do either. Without
      // this the panel has nothing to go on until the turn is stored and read
      // back, so the same failure reads one way while it happens and another
      // after a reload.
      // A call turned away to steer the model has no line; what goes out for
      // it says so, and the panel draws nothing.
      return result.toUIMessageStream({ onError: (err) => wireLineOf(endingOf(err)) });
    };

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // A conversation is named after the first thing said in it, and the
        // name is settled before the model is asked anything. Written ahead
        // of everything below so the panel and the list stop showing a
        // placeholder while the rest of this is still going on.
        if (title !== null) {
          writer.write({ type: "data-conversation-titled", data: { title } });
        }
        // The cards a message closed, so the panel shows them as replied to.
        if (opening.kind === "message") {
          for (const toolCallId of opening.closedAsks) writer.write({ type: "data-ask-replied", data: { toolCallId } });
        }
        writer.merge(await askTheModel(writer));
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
        const exit = isAborted
          ? "aborted"
          : failure !== undefined
            ? "failed"
            : awaitingCall !== undefined
              ? "blocked"
              : "completed";

        // A stretch still open is one the turn broke off inside, and what it
        // had thought so far is still how long it thought. Closed here rather
        // than in the model stream's own end callback: `ai@7.0.68` closes an
        // aborted stream from the reader's abort path
        // (`dist/index.js:9355-9372`) and the callback that would have run
        // instead fires from a flush that returns early with no steps
        // recorded (`:9269-9277`), so a turn stopped during its first step --
        // the stop button pressed while the first answer streams -- never
        // reaches it. This exit runs however the turn ended.
        closeThinking();

        const replyParts = toStoredParts(responseMessage.parts);
        if (thoughtForMs > 0 && !replyParts.some((p) => p.type === "thinking-time")) {
          replyParts.push({ type: "thinking-time", ms: thoughtForMs });
        }

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
        //
        // What a call falls back to once both lookups below have missed --
        // see `tool-ending.ts` for why a call nothing was reported about is
        // one that never ran.
        const leftHanging: ToolFailure = endingWithNothingRun(exit === "aborted");
        for (const [i, part] of replyParts.entries()) {
          if (part.type !== "tool" || part.status !== "pending") continue;
          // The card the reader is shown waits for them; a second card in the
          // same step was turned away. Neither is a call that came to nothing.
          if (exit === "blocked" && part.toolCallId === awaitingCall) {
            replyParts[i] = { ...part, status: "awaiting" };
            continue;
          }
          if (exit === "blocked" && turnedAwayCalls.includes(part.toolCallId)) {
            replyParts[i] = { ...part, status: "error", failure: { kind: "turned_away", forModel: SECOND_QUESTION_TURNED_AWAY } };
            continue;
          }
          // A call the SDK already reported on can still be left pending
          // here: the ending is reported before the chunk carrying it is
          // pulled from the stream, and a stream that ends in between
          // discards that chunk. What it ended with is in hand either way,
          // and asked for before the account above -- that one describes a
          // call nothing was ever reported about, and a call that answered
          // recorded as one that never ran invites the next turn to spend
          // whatever this one already spent all over again.
          if (whatToolAnswered.has(part.toolCallId)) {
            const output = whatToolAnswered.get(part.toolCallId);
            replyParts[i] = { ...part, status: "success", output };
            continue;
          }
          const ending = howToolEnded.get(part.toolCallId) ?? leftHanging;
          replyParts[i] = { ...part, status: "error", failure: ending };
        }

        // Every call is settled now, from either source of a success, so this
        // is where what the model was given gets written down beside each.
        const storedParts = await withModelOutputs(replyParts, turnTools, { conversationId });

        const replyForModel = await keptOfReply({
          exit,
          stored: storedParts,
          parts: responseMessage.parts,
          tools: turnTools,
          settled: { answered: whatToolAnswered, ended: howToolEnded },
        });

        let creditsUsed = 0;
        const failures = await finalizeTurn({
          steps: {
            // Every turn that ran leaves a reply, even one with no parts: a
            // turn that finished having produced nothing is read back as a
            // reply with nothing in it, which is what draws "No reply this
            // turn" when the conversation is opened again.
            persist: async () => {
              await messageRepo.addMessage(
                conversationId,
                { role: "assistant", parts: storedParts, turnIndex },
                replyForModel,
              );
            },
            bill: async () => {
              // An OpenRouter call whose cost is not in hand is looked up and
              // charged later, under a key of its own.
              await calls?.handOff().catch((err: unknown) =>
                logger.error({ err, userId, conversationId, turnIndex }, "usage_lookup_enqueue_failed"),
              );
              creditsUsed = await usage.settle();
              if (creditsUsed === 0) return;

              // The turn-scoped refKey makes this idempotent: a reconnect or
              // a re-entry on the same turn will not double-charge.
              const outcome = await creditLotService.chargeOnceForGeneration(
                usage.operation.operationKey,
                {
                  projectId,
                  actorUserId: userId,
                  amount: creditsUsed,
                  description: "Agent chat",
                  model: modelId,
                  provider: resolveProvider(modelId),
                },
              );
              if (outcome && outcome.shortfall > 0) {
                // The pool ran out mid-turn, or its credits were reassigned
                // while the model was answering. The reply is already with the
                // reader, so what could not be charged goes to reconciliation.
                logger.error(
                  {
                    userId,
                    conversationId,
                    turnIndex,
                    studioId: outcome.studioId,
                    charged: outcome.charged,
                    shortfall: outcome.shortfall,
                  },
                  "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
                );
              }
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

        if (exit === "completed") {
          await this.reportFirstFinishedTurn({ consent, studioId: turnStudioId }).catch((err: unknown) =>
            logger.warn({ err, userId, conversationId }, "first_agent_action_report_failed"),
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
    if (opening.kind !== "answer") return stream;
    // The card a resumed segment answers, as the SDK's own result chunk, put
    // ahead of everything so the browser settles that call in the message it
    // is continuing. Ahead of the stream rather than written into it: what is
    // written into it is also what this side assembles the reply row from,
    // and that row is the resumed segment alone -- the call is in the row
    // that asked.
    const answered: UIMessageChunk = {
      type: "tool-output-available",
      toolCallId: opening.toolCallId,
      output: opening.result,
    };
    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        start(controller) {
          controller.enqueue(answered);
        },
      }),
    );
  }

  /**
   * Send `first_agent_action_completed` when this is the account's first
   * finished turn (inner#1442 design §4.8).
   * @param turn - The finished turn.
   * @param turn.consent - The asking browser's choice.
   * @param turn.studioId - The project's owning studio.
   */
  private async reportFirstFinishedTurn(turn: { consent: ConsentSnapshot; studioId: string }): Promise<void> {
    const { userId, projectId } = this.ctx;
    if (!(await claimFirstMilestone("first-agent", userId))) return;
    if (!serverAnalyticsWanted(turn.consent)) return;
    trackServerEvent(
      "first_agent_action_completed",
      {
        userId,
        insertId: `first-agent:${userId}`,
        properties: { studio_id: turn.studioId || undefined, project_id: projectId },
      },
      turn.consent,
    );
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

/**
 * The picture addresses a `search_images` answer carries.
 * @param output - What the tool answered.
 * @returns Each picture's thumbnail address.
 */
function searchedPictures(output: unknown): string[] {
  const images = (output as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => (image as { thumbnailUrl?: unknown } | null)?.thumbnailUrl)
    .filter((url): url is string => typeof url === "string");
}
