// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory consolidator — folds the oldest part of a conversation into memory.
 *
 * It runs when a turn's request did not fit: the provider's own count left no
 * room, or the provider turned the request away as too long (inner#1567).
 * The caller works out which turns to take, hands them over turn by turn as
 * the messages the model would have been sent, and reassembles once this
 * returns. A reassembly that fails after it ends the turn as failed; nothing
 * here decides whether the turn goes on.
 *
 * A fold that does not produce an answer gives its window up — three
 * failed calls, an answer that is not the JSON it asked for, a write that
 * cannot land. The watermark moves, nothing is written and the error is
 * logged. Holding the window instead would send the same input on the next
 * turn and every turn after it, since the history only grows and the call
 * asks for `temperature: 0` wherever the model takes it.
 *
 * The one failure that is not given up at once is the consolidation call
 * itself being turned away as too long: how many tokens the window is cannot
 * be known before it is sent, so the window is halved and sent again —
 * whole turns while there are several, then the one turn's text — at most
 * `consolidation_shrink_attempts` times, after which it is given up like any
 * other failure.
 *
 * The one ending that keeps the window is the reader leaving: they come back
 * to a conversation that folds it again, and the charge is already keyed so
 * the second attempt is not paid for twice.
 */

import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import {
  generateTextRetry,
  getModel,
  callOptionsFor,
  creditLotService,
  createUsageRecorder,
  handOffLookups,
  resolveProvider,
} from "@breatic/domain";
import type { UsageRecorder } from "@breatic/domain";
import { getAgentConfig, logger } from "@breatic/core";
import { memoryService } from "@server/modules";
import { readContextOverflow } from "@server/agent/context-overflow.js";

const CONSOLIDATION_PROMPT = `\
You are a memory consolidator for an AI creative assistant. Your job is to analyze conversation messages and extract key information into a structured memory update.

Current memory state:
- Conversation memory: {conversation_memory}
- Project context: {project_memory}

Messages to consolidate:
{messages}

Produce a JSON object with these fields:
{
  "conversationUpdate": "Complete rewrite of conversation memory incorporating the new information. Be concise but preserve all important facts, decisions, and context. This replaces the entire conversation memory.",
  "projectUpdate": "New project-level insights that carry across this member's conversations in this project (creative direction, style choices, asset details). Set to null if no project-relevant insights.",
  "historyEntry": "One-line summary of what was discussed in these messages."
}

Rules:
- conversationUpdate REWRITES the full memory — incorporate existing memory + new info
- conversationUpdate MUST stay under {max_chars} characters; the cut keeps the start of what you write and drops the rest before the memory is ever read, so put what matters most at the beginning
- projectUpdate only when there are genuine cross-conversation insights
- Be concise — this text will be injected into future LLM context windows
- Respond ONLY with the JSON object, no markdown or explanation
- Respond in the same language as the messages`;

/** One window of a conversation, and where it sits. */
export interface ConsolidationWindow {
  /** Whose conversation it is. */
  userId: string;
  /** The conversation being folded. */
  conversationId: string;
  /** The project it belongs to. */
  projectId: string;
  /**
   * The window turn by turn, oldest first, as the model would have been sent
   * it, less the model's own working.
   *
   * Grouped by turn rather than flat because halving keeps whole turns, and a
   * turn's boundary cannot be read off its messages: a segment resumed after a
   * questionnaire puts a second user message inside one turn.
   */
  turns: ReadonlyArray<{ turnIndex: number; messages: readonly ModelMessage[] }>;
  /** Where the watermark stood before this window was taken. */
  watermarkBefore: number;
  /** The turn the window ends on. */
  newWatermark: number;
  /** Raised when the reader stopped the turn or the client went away. */
  signal?: AbortSignal;
}

/** How one consolidation ended. */
export type ConsolidationOutcome =
  /** Both layers written, watermark moved. */
  | "written"
  /** Nothing written; the watermark moved so the window is not read again. */
  | "discarded"
  /** Another request had already folded further; nothing written. */
  | "superseded"
  /** The reader left; nothing written, and the watermark stays for next turn. */
  | "aborted"
  /**
   * The watermark is where it was, and the window is still in the history.
   *
   * Told apart from `discarded` because the two say opposite things about the
   * window. `discarded` is what a fold that produced no answer ends as, and
   * the watermark moves. This is the narrower case where the fold never
   * started — the database was briefly away while the memory it rewrites was
   * being read — or where even the discard could not be recorded.
   */
  | "untouched";

/** What the consolidating model is asked to produce. */
interface ConsolidationAnswer {
  conversationUpdate: string;
  projectUpdate: string | null;
  historyEntry: string;
}

/**
 * One part of a message, as the prompt reads it: the words, a tool's name and
 * arguments, or what it answered. Anything else is left out -- the model's
 * working, and a provider's private metadata.
 * @param part - A part of a message's content.
 * @returns Its text, or null when it is left out.
 */
function partText(part: unknown): string | null {
  const p = part as { type?: string; text?: string; toolName?: string; input?: unknown; output?: unknown };
  switch (p.type) {
    case "text":
      return p.text ?? "";
    case "tool-call":
      return `[called ${p.toolName ?? ""}] ${JSON.stringify(p.input ?? null)}`;
    case "tool-result": {
      const output = p.output as { value?: unknown } | undefined;
      const value = output?.value;
      return `[${p.toolName ?? ""} answered] ${typeof value === "string" ? value : JSON.stringify(value ?? output ?? null)}`;
    }
    default:
      return null;
  }
}

/**
 * Render the window the way the prompt reads it.
 * @param turns - The window, turn by turn.
 * @param maxChars - Cut the text to this many characters, saying how many
 *   were left out; absent, the whole text.
 * @returns One block of text, speaker by speaker.
 * @throws {never} Never.
 */
function transcribe(turns: ConsolidationWindow["turns"], maxChars?: number): string {
  const text = turns
    .flatMap((turn) => turn.messages)
    .map((message) => {
      const said =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => partText(part) ?? []).join("\n");
      return `[${message.role}]: ${said}`;
    })
    .join("\n\n");
  if (maxChars === undefined || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[${String(text.length - maxChars)} characters omitted]`;
}

/**
 * Read the model's answer.
 * @param text - What the model replied with.
 * @returns The parsed answer, or null when there is no JSON object in it.
 */
function readAnswer(text: string): ConsolidationAnswer | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as ConsolidationAnswer;
  } catch {
    return null;
  }
}

/** Who ran one consolidation, over which window, and what it cost. */
interface ConsolidationBill {
  /** Who ran it; recorded as the actor and as the payer of last resort. */
  userId: string;
  /** The conversation it folded. */
  conversationId: string;
  /** Whose studio pays, by way of the project. */
  projectId: string;
  /** Where the watermark stood; half of the idempotency key. */
  watermarkBefore: number;
  /** The recorder the call was recorded on; what it settles to is charged. */
  usage: UsageRecorder;
  /** Which model spent it. */
  model: string;
}

/**
 * The key one window's consolidation is recorded and charged under. Two tabs
 * that took the same window derive the same key from the watermark they
 * started at, and the second charge is refused.
 * @param conversationId - The conversation it folded.
 * @param watermarkBefore - Where the watermark stood.
 * @returns The key.
 */
function consolidationKey(conversationId: string, watermarkBefore: number): string {
  return `consolidate:${conversationId}:${watermarkBefore}`;
}

/**
 * Charge the studio for one consolidation, and never fail over it.
 *
 * The tokens are spent by the time this is called and the reader is waiting
 * on a reply. Letting a charge take the turn down would fail an answer that
 * has nothing wrong with it, over bookkeeping nobody sees.
 * @param input - Who ran it, over which window, and what it cost.
 */
async function bill(input: ConsolidationBill): Promise<void> {
  const { userId, conversationId, projectId, watermarkBefore, usage, model } = input;

  try {
    const amount = await usage.settle();
    // An OpenRouter call whose cost is not in hand is looked up and charged
    // later, under a key of its own.
    await handOffLookups(usage.awaitingLookup(), usage.operation, {
      model,
      description: "Memory consolidation",
      charge: true,
    }).catch((err: unknown) =>
      logger.error({ err, userId, conversationId, watermarkBefore }, "usage_lookup_enqueue_failed"),
    );
    if (amount === 0) return;
    const outcome = await creditLotService.chargeOnceForGeneration(
      usage.operation.operationKey,
      {
        projectId,
        actorUserId: userId,
        amount,
        description: "Memory consolidation",
        model,
        provider: resolveProvider(model),
      },
    );

    if (outcome && outcome.shortfall > 0) {
      // The pool ran out, or its credits were reassigned while this ran. The
      // call already happened, so what could not be charged goes to
      // reconciliation.
      logger.error(
        {
          userId,
          conversationId,
          studioId: outcome.studioId,
          charged: outcome.charged,
          shortfall: outcome.shortfall,
        },
        // The same key the turn's own charge logs under, so one query finds
        // every model call that ran without being paid for.
        "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
      );
    }
    if (outcome?.signalFailure) {
      logger.error({ err: outcome.signalFailure, userId, conversationId, projectId }, "credits_signal_failed");
    }
  } catch (err) {
    logger.error({ err, userId, conversationId, watermarkBefore }, "consolidation_charge_failed");
  }
}

/**
 * Fold one window of a conversation into memory.
 * @param window - The turns to fold and where they sit.
 * @returns How it ended. The caller reassembles when something changed --
 * `written`, `superseded` or `discarded` -- and leaves the request alone for
 * `aborted` and `untouched`, where the history it measured still stands.
 */
export async function consolidateWindow(
  window: ConsolidationWindow,
): Promise<ConsolidationOutcome> {
  const {
    userId,
    conversationId,
    projectId,
    watermarkBefore,
    signal,
  } = window;
  // What this attempt sends; a call turned away as too long halves it.
  let turns = window.turns;
  let newWatermark = window.newWatermark;
  let maxChars: number | undefined;

  // A model call with a bill on it and nobody left to read what it produces.
  // The watermark stays where it is, so the next turn folds the same window.
  if (signal?.aborted) return "aborted";

  /** Which window this is, on every line written about it. */
  const where = { userId, conversationId, projectId, watermarkBefore, newWatermark: window.newWatermark };

  /**
   * Whether the reader left, said so on the way out.
   *
   * Asked of the signal rather than of the error's name — a name says what
   * the provider called it, and one of the names the SDK treats as
   * cancellation is a timeout, which is the opposite case. Recorded here
   * because asking the signal answers who stopped the turn and not what went
   * wrong in it: a write that deadlocked while the reader happened to close
   * the tab leaves by this door too, and would otherwise leave no trace.
   * @param err - What the failing step threw.
   * @returns True when the reader had already gone.
   */
  const readerLeft = (err: unknown): boolean => {
    if (signal?.aborted !== true) return false;
    logger.error({ err, ...where }, "memory_consolidation_aborted");
    return true;
  };

  const config = getAgentConfig();

  // Everything the call is built from, gathered before a single token is
  // spent. The database is the part that can be briefly away; `getModel`
  // takes any string and defers to the provider, so a wrong model name and a
  // missing key both surface later, from the call itself. A read that failed
  // here costs this turn its fold and nothing else: the fold never started,
  // so the window is still whole and the next turn folds it again.
  let promptFor: () => string;
  let model: ReturnType<typeof getModel>;
  try {
    // The same two layers a turn is given, through the same door. Read
    // straight from the repository they would be the untruncated rows, so the
    // "current memory state" the rewriting model is shown would be a longer
    // text than any turn injects — and it is asked to rewrite what it sees.
    const { conversationMemory, projectMemory } = await memoryService.buildContext(
      userId,
      conversationId,
      projectId,
    );

    // One pass over the template, with a function for the replacement. Chained
    // calls rescan what the previous one inserted, so memory holding the
    // literal `{messages}` would take the transcript's place; and a string
    // replacement reads `$&` and its siblings in the inserted text as
    // patterns, which anyone who pasted a regex into the conversation has.
    // A replacer function is handed the text and returns it as it is.
    promptFor = (): string => {
      const values: Record<string, string> = {
        conversation_memory: conversationMemory || "(empty)",
        project_memory: projectMemory || "(empty)",
        // The ceiling the answer will actually be read through: a longer answer
        // is written, stored, paid for, and then cut where the ceiling falls.
        max_chars: String(config.memory_conversation_max_size),
        messages: transcribe(turns, maxChars),
      };
      return CONSOLIDATION_PROMPT.replace(
        /\{(conversation_memory|project_memory|max_chars|messages)\}/g,
        (_whole, key: string) => values[key] ?? "",
      );
    };

    model = getModel(config.consolidation_model);
  } catch (err) {
    if (readerLeft(err)) return "aborted";
    logger.error(
      { err, ...where },
      "memory_consolidation_untouched",
    );
    return "untouched";
  }

  // From here on the model is involved, so every ending below has a call
  // behind it that has to be paid for and cannot be repeated for free.
  // How many times the window was halved before the call ended, for the
  // failure line below.
  let shrinks = 0;
  try {
    // One call, and the retrying happens inside it: `generateTextRetry` is
    // handed `llm_max_retries`, so this is one original and two retries.
    // Turned away as too long, it is sent again with half the window, up to
    // `consolidation_shrink_attempts` times.
    let result: Awaited<ReturnType<typeof generateTextRetry>>;
    for (; ; shrinks += 1) {
      try {
        result = await generateTextRetry({
          model,
          messages: [{ role: "user" as const, content: promptFor() }],
          stopWhen: stepCountIs(1),
          // Folding a transcript into a summary has no reasoning step in it, and
          // asks for a fixed temperature of 0. Which of the two each model takes,
          // and how, is settled in the routing table: Claude, for one, accepts
          // neither and is sent neither.
          ...callOptionsFor(config.consolidation_model, { thinking: false, cache: false, temperature: 0 }),
          // Conversation memory is rewritten whole by this call, so an answer
          // with no ceiling is a segment with no ceiling in every later prompt.
          maxOutputTokens: config.max_output_tokens,
          ...(signal ? { abortSignal: signal } : {}),
        });
        break;
      } catch (err) {
        // A rejected call reports no usage and is not charged; only the
        // call that comes back is.
        if (readContextOverflow(err) === undefined || shrinks >= config.consolidation_shrink_attempts) throw err;
        if (turns.length > 1) {
          // The older half of the whole turns, and the watermark back to match.
          turns = turns.slice(0, Math.floor(turns.length / 2));
          newWatermark = turns.at(-1)?.turnIndex ?? newWatermark;
        } else {
          maxChars = Math.floor((maxChars ?? transcribe(turns).length) / 2);
        }
        logger.warn({ err, ...where, attempt: shrinks + 1, keptTurns: turns.length, maxChars }, "memory_consolidation_shrunk");
      }
    }

    // Billed the moment the call comes back, which is the moment the tokens
    // are gone. What becomes of the answer after this has several endings,
    // and the studio owes the same under every one of them. Two tabs that
    // took the same window derive the same key from the watermark they
    // started at, and the second charge is refused.
    const usage = createUsageRecorder({
      operationKey: consolidationKey(conversationId, watermarkBefore),
      feature: "memory_consolidation",
      actorUserId: userId,
      projectId,
      onMissingCost: (row) => logger.error({ row, ...where }, "agent_usage_cost_missing"),
    });
    usage.recordModelCall({
      source: "model",
      model: config.consolidation_model,
      provider: resolveProvider(config.consolidation_model),
      usage: result.usage,
      providerMetadata: result.providerMetadata,
      generationId: result.response.id,
    });
    await bill({
      userId,
      conversationId,
      projectId,
      watermarkBefore,
      usage,
      model: config.consolidation_model,
    });

    const answer = readAnswer(result.text.trim());
    if (!answer) {
      throw new Error(
        `consolidation answer was not JSON: ${result.text.slice(0, 200)}`,
      );
    }

    const outcome = await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: answer.conversationUpdate,
        ...(answer.projectUpdate ? { projectUpdate: answer.projectUpdate } : {}),
        historyEntry: answer.historyEntry,
      },
      newWatermark,
    });

    // The call was made and paid for whichever ending it reached, so this
    // line is written for both; the message says which. A `written` fold also
    // took turns out of the history, and both facts are reconstructed from
    // here when someone asks later where the money or the turns went.
    logger.info(
      {
        userId,
        conversationId,
        projectId,
        watermarkBefore,
        newWatermark,
        outcome,
        tokensUsed: result.usage?.totalTokens ?? 0,
      },
      outcome === "written"
        ? "memory_consolidation_written"
        : "memory_consolidation_superseded",
    );
    return outcome;
  } catch (err) {
    // The reader leaving is the one ending here that keeps the window: they
    // come back to a conversation that folds it again, and the charge is
    // already keyed so the second attempt is not paid for twice.
    if (readerLeft(err)) return "aborted";

    let lost: boolean;
    try {
      // The whole window passes, not the halved one: it is given up whole.
      lost = await memoryService.discardConsolidation(conversationId, window.newWatermark);
    } catch (discardErr) {
      // The discard is itself a write, and whatever failed above is often the
      // reason this fails too. Both errors go in the line: the one that lost
      // the window and the one that could not record it.
      logger.error(
        { err, discardErr, ...where, shrinks },
        "memory_consolidation_discard_failed",
      );
      return "untouched";
    }

    // One line for both endings, with the field that tells them apart. The
    // fold failed either way and that error is the only account of why;
    // whether this turn's window went with it depends on whether anyone else
    // had already folded it, and `windowLost` is that answer.
    logger.error(
      { err, ...where, windowLost: lost, shrinks },
      "memory_consolidation_failed",
    );
    return lost ? "discarded" : "superseded";
  }
}
