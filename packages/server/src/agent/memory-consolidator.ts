// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory consolidator — folds the oldest part of a conversation into memory.
 *
 * It runs in front of the reply, on the turn whose assembled request went over
 * the budget: the caller works out which turns to take, hands them over as the
 * messages the model would have been sent, and reassembles once this returns.
 *
 * The turn goes out however this ends: the reply is what is promised, and a
 * fold is what keeps the request small enough to make one and the earlier
 * conversation represented rather than simply dropped.
 *
 * So a fold that does not produce an answer gives its window up — three
 * failed calls, an answer that is not the JSON it asked for, a write that
 * cannot land. The watermark moves, nothing is written, the error is logged
 * and the reply goes out. Holding the window instead would send the same
 * input on the next turn and every turn after it, since the call is
 * `temperature: 0` and the history only grows.
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
  creditLotService,
  resolveProvider,
} from "@breatic/domain";
import { getAgentConfig, logger } from "@breatic/core";
import { memoryService } from "@server/modules";
import { creditsForTokens } from "@server/modules/credit/token-pricing.js";

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
   * The window, as the model would have been sent it.
   *
   * The assembled messages rather than the stored rows: compression has
   * already replaced the body of every old tool result, and reading storage
   * would put all of it back — the very bulk this exists to be rid of.
   */
  transcript: readonly ModelMessage[];
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
 * Render the window the way the prompt reads it.
 * @param transcript - The window, as assembled messages.
 * @returns One block of text, speaker by speaker.
 */
function transcribe(transcript: readonly ModelMessage[]): string {
  return transcript
    .map((message) => {
      const said =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      return `[${message.role}]: ${said}`;
    })
    .join("\n\n");
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
  /** What the call spent. */
  tokensUsed: number;
  /** Which model spent it. */
  model: string;
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
  const { userId, conversationId, projectId, watermarkBefore, tokensUsed, model } = input;
  if (tokensUsed === 0) return;

  try {
    const outcome = await creditLotService.chargeOnceForGeneration(
      `consolidate:${conversationId}:${watermarkBefore}`,
      {
        projectId,
        actorUserId: userId,
        amount: creditsForTokens(tokensUsed),
        description: "Memory consolidation",
        tokensUsed,
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
  } catch (err) {
    logger.error({ err, userId, conversationId, watermarkBefore }, "consolidation_charge_failed");
  }
}

/**
 * Fold one window of a conversation into memory.
 * @param window - The turns to fold and where they sit.
 * @returns How it ended; the caller reassembles for every outcome but `aborted`.
 */
export async function consolidateWindow(
  window: ConsolidationWindow,
): Promise<ConsolidationOutcome> {
  const {
    userId,
    conversationId,
    projectId,
    transcript,
    watermarkBefore,
    newWatermark,
    signal,
  } = window;

  // A model call with a bill on it and nobody left to read what it produces.
  // The watermark stays where it is, so the next turn folds the same window.
  if (signal?.aborted) return "aborted";

  const config = getAgentConfig();

  // Everything the call is built from, gathered before a single token is
  // spent. The database is the part that can be briefly away; `getModel`
  // takes any string and defers to the provider, so a wrong model name and a
  // missing key both surface later, from the call itself. A read that failed
  // here costs this turn its fold and nothing else: the fold never started,
  // so the window is still whole and the next turn folds it again.
  let prompt: string;
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
    const values: Record<string, string> = {
      conversation_memory: conversationMemory || "(empty)",
      project_memory: projectMemory || "(empty)",
      // The ceiling the answer will actually be read through: a longer answer
      // is written, stored, paid for, and then cut where the ceiling falls.
      max_chars: String(config.memory_conversation_max_size),
      messages: transcribe(transcript),
    };
    prompt = CONSOLIDATION_PROMPT.replace(
      /\{(conversation_memory|project_memory|max_chars|messages)\}/g,
      (_whole, key: string) => values[key] ?? "",
    );

    model = getModel(config.consolidation_model);
  } catch (err) {
    if (signal?.aborted) {
      logger.error(
        { err, userId, conversationId, watermarkBefore, newWatermark },
        "memory_consolidation_aborted",
      );
      return "aborted";
    }
    logger.error(
      { err, userId, conversationId, watermarkBefore, newWatermark },
      "memory_consolidation_untouched",
    );
    return "untouched";
  }

  // From here on the model is involved, so every ending below has a call
  // behind it that has to be paid for and cannot be repeated for free.
  try {
    // One call, and the retrying happens inside it: `generateTextRetry` is
    // handed `llm_max_retries`, so this is one original and two retries.
    const result = await generateTextRetry({
      model,
      messages: [{ role: "user" as const, content: prompt }],
      stopWhen: stepCountIs(1),
      temperature: 0,
      // Conversation memory is rewritten whole by this call, so an answer
      // with no ceiling is a segment with no ceiling in every later prompt.
      maxOutputTokens: config.max_output_tokens,
      ...(signal ? { abortSignal: signal } : {}),
    });

    // Billed the moment the call comes back, which is the moment the tokens
    // are gone. What becomes of the answer after this has several endings,
    // and the studio owes the same under every one of them. Two tabs that
    // took the same window derive the same key from the watermark they
    // started at, and the second charge is refused.
    await bill({
      userId,
      conversationId,
      projectId,
      watermarkBefore,
      tokensUsed: result.usage?.totalTokens ?? 0,
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

    // The one ending here that changes things and would otherwise say nothing:
    // the studio was charged and turns left the history. Both are reconstructed
    // from this line when someone asks later where the money or the turns went.
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
      "memory_consolidation_written",
    );
    return outcome;
  } catch (err) {
    // The reader leaving is the one ending here that keeps the window: they
    // come back to a conversation that folds it again, and the charge is
    // already keyed so the second attempt is not paid for twice. Asked of the
    // signal rather than of the error's name — a name says what the provider
    // called it, and one of the names the SDK treats as cancellation is a
    // timeout, which is the opposite case.
    //
    // Logged on the way out, because asking the signal answers who stopped
    // the turn and not what went wrong in it: a write that deadlocked while
    // the reader happened to close the tab leaves by this door too, and
    // without this line it leaves without a trace.
    if (signal?.aborted) {
      logger.error(
        { err, userId, conversationId, watermarkBefore, newWatermark },
        "memory_consolidation_aborted",
      );
      return "aborted";
    }

    let lost: boolean;
    try {
      lost = await memoryService.discardConsolidation(conversationId, newWatermark);
    } catch (discardErr) {
      // The discard is itself a write, and whatever failed above is often the
      // reason this fails too. Both errors go in the line: the one that lost
      // the window and the one that could not record it.
      logger.error(
        { err, discardErr, userId, conversationId, watermarkBefore, newWatermark },
        "memory_consolidation_discard_failed",
      );
      return "untouched";
    }

    // Nothing moved, which means another turn took this same window and
    // folded it while this one was failing. Its turns are in the memory the
    // other one wrote, so this ending lost nothing and the line below would
    // say it had.


    if (!lost) return "superseded";

    // Written after the discard, so the line that says the window is gone is
    // only there on the path where it went.
    logger.error(
      { err, userId, conversationId, watermarkBefore, newWatermark },
      "memory_consolidation_discarded",
    );
    return "discarded";
  }
}
