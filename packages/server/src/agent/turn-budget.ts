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
import { getAgentConfig } from "@breatic/core";
import type { MessageData } from "@breatic/shared";
import type { ResolvedAgentConfig } from "@breatic/domain";
import { measureMessages, measurePayload } from "@server/agent/payload-size.js";
import { planConsolidation } from "@server/agent/consolidation-window.js";
import type { TurnCost } from "@server/agent/consolidation-window.js";
import { toModelMessages } from "@server/agent/model-messages.js";
import { consolidateWindow } from "@server/agent/memory-consolidator.js";

/** One reading of everything a turn sends, and what it was built from. */
export interface Assembly {
  /** Model, instructions and tools, as the factory resolved them. */
  agentConfig: ResolvedAgentConfig;
  /** The unconsolidated history this assembly read. */
  history: MessageData[];
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
}

/**
 * What each turn in the history costs the assembled request.
 *
 * Priced one turn at a time with the same function the whole is priced with:
 * a consolidation takes whole turns, and what it needs to know about each of
 * them is how much taking it saves.
 * @param history - The unconsolidated history, oldest first.
 * @returns Each turn and its cost, oldest first.
 */
function costPerTurn(history: readonly MessageData[]): TurnCost[] {
  const byTurn = new Map<number, MessageData[]>();
  for (const message of history) {
    const found = byTurn.get(message.turnIndex);
    if (found) found.push(message);
    else byTurn.set(message.turnIndex, [message]);
  }

  return [...byTurn.entries()]
    .sort(([a], [b]) => a - b)
    .map(([turnIndex, messages]) => ({
      turnIndex,
      chars: measureMessages(toModelMessages(messages)),
    }));
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
  const assembled = measurePayload({
    instructions: assembly.agentConfig.instructions,
    tools: assembly.agentConfig.tools,
    messages: assembly.messages,
  });
  // The planner asks this again and is the authority on it. Asked here first
  // because the answer is no on almost every turn, and the pricing below
  // renders every turn of the history to find out what it costs.
  if (assembled <= config.memory_budget_chars) return false;

  const turns = costPerTurn(assembly.history);
  const historyChars = turns.reduce((sum, turn) => sum + turn.chars, 0);

  const plan = planConsolidation({
    // Everything the fold cannot touch: the prompt, the tools, the memory and
    // the question just asked.
    fixedCost: assembled - historyChars,
    turns,
    budget: config.memory_budget_chars,
    keep: config.memory_keep_chars,
  });
  if (!plan.shouldConsolidate || plan.newWatermark === null) return false;

  const taken = new Set(plan.takenTurns);
  const outcome = await consolidateWindow({
    userId: who.userId,
    conversationId: who.conversationId,
    projectId: who.projectId,
    // The window as the model would have been sent it, placeholders and all.
    transcript: toModelMessages(assembly.history.filter((m) => taken.has(m.turnIndex))),
    watermarkBefore: assembly.watermark,
    newWatermark: plan.newWatermark,
    ...(who.signal ? { signal: who.signal } : {}),
  });

  // Reassemble for every outcome but a stop. The window is past the watermark
  // whether its summary was written, discarded, or lost a race to a further
  // one, so this assembly is holding turns the history no longer has.
  return outcome !== "aborted";
}
