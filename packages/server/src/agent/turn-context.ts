// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a turn is given before it starts: the memory and the history.
 *
 * Assembled in one place because both chat entrances need the same thing and
 * had been building it separately — the same six lines, the same order, the
 * same three services. Two copies of an assembly is two places to change when
 * what a turn is given changes, and the only sign they had come apart would
 * be a turn behaving differently depending on which entrance it came through.
 */

import { getAgentConfig } from "@breatic/core";
import { conversationService, memoryService } from "@server/modules";
import { compressForContext } from "@server/agent/message-compressor.js";
import type { MemoryContext, MessageData } from "@breatic/shared";

/** Everything a turn reads before its first token. */
export interface TurnContext {
  /** The three memory layers, loaded once for this turn. */
  memoryContext: MemoryContext;
  /** What has been said so far, with old turns reduced to their prose. */
  compressedHistory: MessageData[];
}

/**
 * Gather what this turn is given.
 * @param userId - Who is speaking.
 * @param conversationId - The conversation, already checked as this user's.
 * @param projectId - The project it belongs to.
 * @param runningTurn - The turn being run, left out of the history it builds
 * @returns The memory and the history the turn runs against.
 */
export async function buildTurnContext(
  userId: string,
  conversationId: string,
  projectId: string,
  runningTurn: number,
): Promise<TurnContext> {
  const agentCfg = getAgentConfig();
  const memoryContext = await memoryService.buildContext(
    userId,
    conversationId,
    projectId,
    "agent_chat",
  );

  // Turns already folded into memory are not read again: the watermark is
  // where that folding got to, and everything under it is represented by the
  // memory loaded above.
  const conversation = await conversationService.getConversation(conversationId);
  const rawHistory = await conversationService.getMessagesForLlm(
    conversationId,
    conversation?.lastConsolidatedTurn ?? 0,
    runningTurn,
  );

  return {
    memoryContext,
    compressedHistory: compressForContext(rawHistory, agentCfg.full_detail_turns),
  };
}
