// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory consolidator — folds the oldest part of a conversation into memory.
 *
 * It runs in front of the reply, on the turn whose assembled request went over
 * the budget: the caller works out which turns to take, hands them over as the
 * messages the model would have been sent, and reassembles once this returns.
 *
 * There are two results and nothing in between. Either the memory and the
 * watermark both move, or neither memory is written and the watermark moves
 * anyway — the window is discarded and the turn goes out regardless. Leaving
 * the watermark behind for a later retry is what would wedge the conversation:
 * this call is `temperature: 0`, so the next turn would send a strictly larger
 * version of an input that already failed, deterministically, on every turn
 * from then on.
 */

import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import {
  generateTextRetry,
  getModel,
  creditLotService,
  resolveProvider,
} from "@breatic/domain";
import { ConflictError, getAgentConfig, env, logger } from "@breatic/core";
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
  /** A version race on the project layer; nothing written, try again next turn. */
  | "contended"
  /** The reader left; nothing written. */
  | "aborted";

/**
 * Whether this is the reader walking away rather than something going wrong.
 *
 * The same three names `@ai-sdk/provider-utils` checks in its own
 * `isAbortError` (`dist/index.js:1219`), read here rather than imported: it
 * reaches this package only as a transitive dependency.
 * @param err - What was thrown.
 * @returns True when the call was cancelled.
 */
function isAbort(err: unknown): boolean {
  if (!(err instanceof Error) && !(err instanceof DOMException)) return false;
  return err.name === "AbortError" || err.name === "ResponseAborted" || err.name === "TimeoutError";
}

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
 * Charge the studio for one consolidation.
 * @param input - Who ran it, over which window, and what it cost.
 */
async function bill(input: ConsolidationBill): Promise<void> {
  const { userId, conversationId, projectId, watermarkBefore, tokensUsed, model } = input;
  if (tokensUsed === 0) return;

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
    // memory is already written, so what could not be charged goes to
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
  const existingConvMemory = await memoryRepo.getConversationMemory(conversationId);
  const existingProjectMemory = projectId
    ? await memoryRepo.getProjectMemory(userId, projectId)
    : "";

  const prompt = CONSOLIDATION_PROMPT.replace(
    "{conversation_memory}",
    existingConvMemory || "(empty)",
  )
    .replace("{project_memory}", existingProjectMemory || "(empty)")
    .replace("{messages}", transcribe(transcript));

  let outcome: ConsolidationOutcome;
  let tokensUsed = 0;
  try {
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
    tokensUsed = result.usage?.totalTokens ?? 0;

    const answer = readAnswer(result.text.trim());
    if (!answer) {
      throw new Error(
        `consolidation answer was not JSON: ${result.text.slice(0, 200)}`,
      );
    }

    outcome = await memoryService.commitConsolidation({
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
    // Two of the three ways this can end are retryable, and discarding on
    // either would lose turns that are then in neither the history nor the
    // memory. The reader who left will come back to a conversation that folds
    // the same window; the version race resolves itself against the newer
    // row. Only a window that cannot be summarised at all is thrown away.
    if (isAbort(err)) return "aborted";
    if (err instanceof ConflictError) return "contended";

    logger.error(
      { err, userId, conversationId, watermarkBefore, newWatermark },
      "memory_consolidation_discarded",
    );
    await memoryService.discardConsolidation(conversationId, newWatermark);
    return "discarded";
  }

  // Billed whichever way the write went: the model ran and the tokens were
  // spent either way. Two tabs that took the same window derive the same key
  // from the watermark they started at, and the second charge is refused.
  try {
    await bill({
      userId,
      conversationId,
      projectId,
      watermarkBefore,
      tokensUsed,
      model: config.consolidation_model,
    });
  } catch (err) {
    // The memory is written and the watermark has moved. Letting this take
    // the turn down would fail a reply with nothing wrong with it, over
    // bookkeeping the reader never sees.
    logger.error(
      { err, userId, conversationId, watermarkBefore },
      "consolidation_charge_failed",
    );
  }

  return outcome;
}
