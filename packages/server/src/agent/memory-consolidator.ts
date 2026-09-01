// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory consolidator — folds the oldest part of a conversation into memory.
 *
 * It runs in front of the reply, on the turn whose assembled request went over
 * the budget: the caller works out which turns to take, hands them over as the
 * messages the model would have been sent, and reassembles once this returns.
 *
 * Either the memory and the watermark both move, or nothing is written and the
 * watermark moves anyway — the window is discarded and the turn goes out
 * regardless. Leaving the watermark behind for a later retry is what would
 * wedge the conversation: this call is `temperature: 0`, so the next turn
 * would send a strictly larger version of an input that already failed,
 * deterministically, on every turn from then on. The one ending that keeps
 * the window is a reader who left, and they left with nothing spent on their
 * behalf that a later turn cannot spend again.
 */

import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import {
  generateTextRetry,
  getModel,
  creditLotService,
  resolveProvider,
} from "@breatic/domain";
import { getAgentConfig, env, logger } from "@breatic/core";
import { memoryService } from "@server/modules";
import * as memoryRepo from "@server/modules/memory/memory.repo.js";

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
- conversationUpdate MUST stay under {max_chars} characters; anything past that is cut off before the memory is ever read, and the newest material is what goes first
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
  /** The project it belongs to, when it has one. */
  projectId?: string;
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
   * Nothing ran and nothing was spent; the watermark stays for next turn.
   *
   * Told apart from `discarded` because the two say opposite things about the
   * window. A fold that reached the model and then failed has to give the
   * window up: the call is `temperature: 0`, so retrying sends the same input
   * forever. A fold that never reached the model has nothing to give up.
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
  projectId: string | undefined;
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
        projectId: projectId ?? null,
        actorUserId: userId,
        amount: Math.ceil((tokensUsed / 1000) * env.CREDIT_MULTIPLIER),
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
        "consolidation_charge_shortfall",
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

  // What the window is folded against. Read before anything is spent, so a
  // database that is briefly away costs this turn its fold and nothing else.
  let existingConvMemory: string;
  let existingProjectMemory: string;
  try {
    existingConvMemory = await memoryRepo.getConversationMemory(conversationId);
    existingProjectMemory = projectId
      ? await memoryRepo.getProjectMemory(userId, projectId)
      : "";
  } catch (err) {
    if (signal?.aborted) return "aborted";
    logger.error(
      { err, userId, conversationId, watermarkBefore, newWatermark },
      "memory_consolidation_untouched",
    );
    return "untouched";
  }

  // From here on the model is involved, so every ending below has a call
  // behind it that has to be paid for and cannot be repeated for free.
  try {
    const prompt = CONSOLIDATION_PROMPT.replace(
      "{conversation_memory}",
      existingConvMemory || "(empty)",
    )
      .replace("{project_memory}", existingProjectMemory || "(empty)")
      // The ceiling the answer will actually be read through. `buildContext`
      // truncates to this before injection, so a longer answer is written,
      // stored, paid for, and then cut mid-sentence every time it is read.
      .replace("{max_chars}", String(config.memory_conversation_max_size))
      .replace("{messages}", transcribe(transcript));

    // One call, and the retrying happens inside it: `generateTextRetry` is
    // handed `llm_max_retries`, so this is one original and two retries.
    const result = await generateTextRetry({
      model: getModel(config.consolidation_model),
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

    return await memoryService.commitConsolidation({
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
  } catch (err) {
    // The reader leaving is the one ending here that keeps the window: they
    // come back to a conversation that folds it again, and the charge is
    // already keyed so the second attempt is not paid for twice. Asked of the
    // signal rather than of the error's name — a name says what the provider
    // called it, and one of the names the SDK treats as cancellation is a
    // timeout, which is the opposite case.
    if (signal?.aborted) return "aborted";

    logger.error(
      { err, userId, conversationId, watermarkBefore, newWatermark },
      "memory_consolidation_discarded",
    );
    try {
      await memoryService.discardConsolidation(conversationId, newWatermark);
    } catch (discardErr) {
      // The discard is itself a write, and whatever failed above is often the
      // reason this fails too. Saying `discarded` here would be claiming a
      // watermark that never moved.
      logger.error(
        { err: discardErr, userId, conversationId, newWatermark },
        "memory_consolidation_discard_failed",
      );
      return "untouched";
    }
    return "discarded";
  }
}
