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
import { planConsolidation } from "@server/agent/consolidation-window.js";
import { consolidateWindow } from "@server/agent/memory-consolidator.js";
import { stripThinking } from "@server/agent/history-replay.js";
import type { ReplayedRow, UserForModel } from "@server/agent/history-replay.js";
import { costPerTurn, requestTokens } from "@server/agent/request-size.js";

/** One reading of everything a turn sends, and what it was built from. */
export interface Assembly {
  /** Model, instructions and tools, as the factory resolved them. */
  agentConfig: ResolvedAgentConfig;
  /** The unconsolidated history this assembly read, row by row as it is replayed. */
  replayed: ReplayedRow[];
  /** How far the conversation was folded when this was read. */
  watermark: number;
  /** This turn's logical message, picture facts and Space snapshot before projection. */
  userKept: UserForModel;
  /** The history and this turn's question, as they will be sent. */
  messages: ModelMessage[];
  /** Initial selected logical facts, reused without restoring omissions within the SDK loop. */
  logicalMessages?: ModelMessage[];
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
  const turns = costPerTurn(assembly.replayed);
  const assembled = requestTokens(assembly, turns);
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
      assembly.replayed.filter((one) => one.row.turnIndex <= newWatermark).flatMap((one) => one.messages),
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
