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
  /** Both memory layers, loaded once for this turn. */
  memoryContext: MemoryContext;
  /** What has been said since the watermark, with old tool results dropped. */
  compressedHistory: MessageData[];
  /**
   * How far the conversation is already folded into memory.
   *
   * Returned rather than looked up again by the caller: a consolidation's
   * billing key is derived from the watermark it started at, and reading it a
   * second time could read one a concurrent request had already moved.
   */
  watermark: number;
}

/**
 * Gather what this turn is given.
 * @param userId - Who is speaking.
 * @param conversationId - The conversation, already checked as this user's.
 * @param projectId - The project it belongs to.
 * @param runningTurn - The turn being run, left out of the history it builds
 * @returns The memory, the history and the watermark the turn runs against.
 */
export async function buildTurnContext(
  userId: string,
  conversationId: string,
  projectId: string,
  runningTurn: number,
): Promise<TurnContext> {
  const agentCfg = getAgentConfig();

  // The watermark first, and the memory after it, so the memory is always at
  // least as new as the watermark it is paired with. A fold running in
  // another tab commits between these two reads: taking the memory first
  // pairs one from before the fold with a watermark from after it, and the
  // turns in between are in neither — gone from the history because the
  // watermark passed them, absent from the memory because it was read before
  // the fold wrote it. This way round the worst case is those turns in both,
  // which costs a little context and loses nothing.
  const conversation = await conversationService.getConversation(conversationId);
  const memoryContext = await memoryService.buildContext(
    userId,
    conversationId,
    projectId,
  );

  // Turns already folded into memory are not read again: the watermark is
  // where that folding got to, and everything under it is represented by the
  // memory loaded above.
  const rawHistory = await conversationService.getMessagesForLlm(
    conversationId,
    conversation?.lastConsolidatedTurn ?? 0,
    runningTurn,
  );

  return {
    memoryContext,
    compressedHistory: compressForContext(rawHistory, agentCfg.tool_result_keep),
    watermark: conversation?.lastConsolidatedTurn ?? 0,
  };
}
