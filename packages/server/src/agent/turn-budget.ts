// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The budget a turn is held to, and what it does when it goes over.
 *
 * Between the assembly and the model call: the request is whole here, so this
 * is the one place its whole length is knowable. What is over the line is
 * folded into memory before the model is asked anything, and the caller
 * assembles again — the fold moved the watermark, so the first assembly is
 * holding turns that are no longer part of the history.
 */

import type { ModelMessage } from "ai";
import { effectiveKeepTokens, getAgentConfig } from "@breatic/core";
import type { ResolvedAgentConfig } from "@breatic/domain";
import { measureMessages, measurePayload } from "@server/agent/payload-size.js";
import { planConsolidation } from "@server/agent/consolidation-window.js";
import type { TurnCost } from "@server/agent/consolidation-window.js";
import { consolidateWindow } from "@server/agent/memory-consolidator.js";
import { replayRows, requestPrefixOf, stripThinking } from "@server/agent/history-replay.js";
import type { ReplayRow, ReplayedRow } from "@server/agent/history-replay.js";

/** One reading of everything a turn sends, and what it was built from. */
export interface Assembly {
  /** Model, instructions and tools, as the factory resolved them. */
  agentConfig: ResolvedAgentConfig;
  /** The unconsolidated history this assembly read. */
  history: ReplayRow[];
  /** How far the conversation was folded when this was read. */
  watermark: number;
  /** The history and this turn's question, as they will be sent. */
  messages: ModelMessage[];
}

/** Who is asking, and whether they are still there. */
export interface TurnIdentity {
  userId: string;
  conversationId: string;
  projectId: string;
  /** Raised when the reader stopped the turn or the client went away. */
  signal?: AbortSignal;
  /**
   * Called once, when a fold is about to run.
   *
   * Fires after the decision and before the model call, so it reaches the
   * reader only on turns that really do stop to fold.
   */
  onStart?: () => void;
}

/**
 * What each turn in the history added to the conversation, oldest first.
 *
 * The provider's count where its reply kept one, which takes in thinking that
 * is replayed but stored only as a summary; otherwise what the turn is sent
 * as, a character counted as a token.
 * @param replayed - The history, row by row, as it is replayed.
 * @returns Each turn and what taking it saves.
 * @throws {never} Never.
 */
function costPerTurn(replayed: readonly ReplayedRow[]): TurnCost[] {
  const byTurn = new Map<number, ReplayedRow[]>();
  for (const one of replayed) {
    const found = byTurn.get(one.row.turnIndex);
    if (found) found.push(one);
    else byTurn.set(one.row.turnIndex, [one]);
  }

  // In turn order: the history is read oldest first.
  return [...byTurn.entries()].map(([turnIndex, rows]) => ({
    turnIndex,
    tokens:
      rows.find((one) => one.reply !== undefined)?.reply?.turnTokens ??
      measureMessages(rows.flatMap((one) => one.messages)),
  }));
}

/**
 * How big the request is, in tokens.
 *
 * The newest reply sent again as it was sent says how big the conversation
 * was when its turn ended, by the provider's count; what came after it is
 * added on. Without one -- the conversation was folded since, or nothing was
 * kept -- it is the system prompt and tools, what each turn added, and this
 * turn's question.
 * @param assembly - What this turn would send.
 * @param replayed - Its history, row by row, as it is replayed.
 * @param turns - What each turn of that history added.
 * @returns The size, a character counted as a token where there is no count.
 * @throws {never} Never.
 */
function assembledTokens(assembly: Assembly, replayed: readonly ReplayedRow[], turns: readonly TurnCost[]): number {
  const question = measureMessages(assembly.messages.slice(-1));
  const newestAsSent = replayed.findLastIndex((one) => one.asSent);
  const sized = replayed[newestAsSent]?.reply;
  if (sized !== undefined) {
    const after = replayed.slice(newestAsSent + 1).flatMap((one) => one.messages);
    return sized.endTokens + measureMessages(after) + question;
  }
  const fixed = measurePayload({
    instructions: assembly.agentConfig.instructions,
    tools: assembly.agentConfig.tools,
    messages: [],
  });
  return fixed + turns.reduce((sum, turn) => sum + turn.tokens, 0) + question;
}

/**
 * Fold the oldest part of the conversation when the request is over budget.
 * @param assembly - What this turn would send as it stands.
 * @param who - Who is asking, and whether they are still there.
 * @returns True when the caller must assemble again.
 */
export async function foldIfOverBudget(
  assembly: Assembly,
  who: TurnIdentity,
): Promise<boolean> {
  const config = getAgentConfig();
  const replayed = replayRows(assembly.history, requestPrefixOf(assembly.agentConfig));
  const turns = costPerTurn(replayed);
  const assembled = assembledTokens(assembly, replayed, turns);
  // The planner asks this again and is the authority on it.
  if (assembled <= config.memory_budget_tokens) return false;

  const plan = planConsolidation({
    assembled,
    turns,
    budget: config.memory_budget_tokens,
    // The keep line a pass runs to: the configured line less the room the
    // fold is about to add, from the one place that arithmetic lives.
    keep: effectiveKeepTokens(config),
  });
  const newWatermark = plan.newWatermark;
  if (newWatermark === null) return false;

  who.onStart?.();

  const outcome = await consolidateWindow({
    userId: who.userId,
    conversationId: who.conversationId,
    projectId: who.projectId,
    // The window as the model was sent it, less the model's own working.
    transcript: stripThinking(
      replayed.filter((one) => one.row.turnIndex <= newWatermark).flatMap((one) => one.messages),
    ),
    watermarkBefore: assembly.watermark,
    newWatermark,
    ...(who.signal ? { signal: who.signal } : {}),
  });

  // Reassemble when the watermark moved. These three leave it further along,
  // so this assembly is holding turns the history no longer has; the endings
  // left out of the list are the ones that changed nothing at all, and
  // reading again would return the same thing at the cost of the queries.
  return outcome === "written" || outcome === "superseded" || outcome === "discarded";
}
