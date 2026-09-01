// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory service — orchestrates the two memory layers.
 *
 * Reads and writes conversation and project memory. Used by the agent system
 * to build LLM context and persist consolidation results.
 *
 * Both layers are the reader's own: project memory is keyed by member as well
 * as project, so nothing one person's agent summarised reaches another's
 * prompt.
 */

import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import { db, getAgentConfig } from "@breatic/core";
import type { MemoryContext } from "@breatic/shared";

/** Scenarios determining which memory layers are loaded. */
type Scenario = "agent_chat" | "canvas_node" | "edit_area";

/**
 * Assemble memory context for injection into an LLM system prompt.
 *
 * Injection strategy by scenario:
 * - `agent_chat`: project + conversation memory
 * - `canvas_node` / `edit_area`: project only (no conversation)
 *
 * Both layers are truncated to the max sizes in agent config. The
 * conversation layer needs its own ceiling because consolidation rewrites it
 * whole every time it runs, so it is the one segment that grows itself.
 * @param userId - The current user's ID
 * @param conversationId - The active conversation ID (may be undefined)
 * @param projectId - The associated project ID (may be undefined)
 * @param scenario - Where the AI is being invoked
 * @returns A MemoryContext with the appropriate fields populated
 */
export async function buildContext(
  userId: string,
  conversationId?: string,
  projectId?: string,
  scenario: Scenario = "agent_chat",
): Promise<MemoryContext> {
  const config = getAgentConfig();

  let projectMemory = "";
  if (projectId) {
    projectMemory = await memoryRepo.getProjectMemory(userId, projectId);
  }

  let conversationMemory = "";
  if (scenario === "agent_chat" && conversationId) {
    conversationMemory =
      await memoryRepo.getConversationMemory(conversationId);
  }

  return {
    projectMemory: truncate(projectMemory, config.memory_project_max_size),
    conversationMemory: truncate(
      conversationMemory,
      config.memory_conversation_max_size,
    ),
  };
}

/** Consolidation data from the LLM memory rewriter. */
export interface ConsolidationData {
  conversationUpdate: string;
  projectUpdate?: string;
  historyEntry: string;
}

/** One consolidation's results, and how far it says the conversation is folded. */
export interface ConsolidationCommit {
  /** Whose memory this is. */
  userId: string;
  /** The conversation that was read. */
  conversationId: string;
  /** The project it belongs to, when it has one. */
  projectId: string | undefined;
  /** What the model produced. */
  data: ConsolidationData;
  /** The turn the window ended on. */
  newWatermark: number;
}

/**
 * Write one consolidation, or nothing at all.
 *
 * The memory and the watermark go in one transaction because the invariant
 * that makes the watermark meaningful spans both: everything under it is
 * supposed to be in memory. Written separately, a crash between them leaves
 * turns that are in neither — gone from the history because the watermark
 * passed them, and absent from memory because that write never happened.
 *
 * The watermark moves first and only forwards. Two tabs on one conversation
 * compute different windows, and the narrower one must not overwrite memory
 * that already covers more; finding the watermark already further along is
 * that answer, and it costs the caller a reassembly rather than any data.
 * @param commit - The results and the watermark they cover.
 * @returns Whether this call's memory landed.
 */
export async function commitConsolidation(
  commit: ConsolidationCommit,
): Promise<"written" | "superseded"> {
  const { userId, conversationId, projectId, data, newWatermark } = commit;

  return db.transaction(async (tx) => {
    const moved = await conversationRepo.advanceConsolidatedTurn(
      conversationId,
      newWatermark,
      tx,
    );
    if (!moved) return "superseded";

    await memoryRepo.upsertConversationMemory(conversationId, data.conversationUpdate, tx);
    await memoryRepo.appendHistory(conversationId, data.historyEntry, tx);

    if (data.projectUpdate && projectId) {
      await memoryRepo.appendProjectEntry(
        projectId,
        userId,
        data.projectUpdate,
        conversationId,
        tx,
      );
      await memoryRepo.upsertProjectMemory(userId, projectId, data.projectUpdate, tx);
    }
    return "written";
  });
}

/**
 * Move the watermark past a window whose summary never arrived.
 *
 * The turns it covered are lost. Leaving the watermark where it is would be
 * worse: the consolidating call is `temperature: 0`, so the next turn sends a
 * strictly larger version of an input that already failed, and does so on
 * every turn from then on. Nothing the reader can do — refreshing, relogging,
 * another tab — changes any of the inputs.
 * @param conversationId - The conversation whose window was discarded.
 * @param newWatermark - The turn the window ended on.
 */
export async function discardConsolidation(
  conversationId: string,
  newWatermark: number,
): Promise<void> {
  await conversationRepo.advanceConsolidatedTurn(conversationId, newWatermark);
}

/**
 * Truncate a string to a maximum character count.
 * @param text - Source string to truncate.
 * @param maxLength - Maximum number of characters to keep.
 * @returns The original string if within the limit, otherwise the first `maxLength` characters.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}
