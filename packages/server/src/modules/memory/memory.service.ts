// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory service — orchestrates the two memory layers.
 *
 * Reads and writes conversation and project memory, applying optimistic
 * locking on the versioned one. Used by the agent system to build LLM context
 * and persist consolidation results.
 *
 * Both layers are the reader's own: project memory is keyed by member as well
 * as project, so nothing one person's agent summarised reaches another's
 * prompt.
 */

import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import { getAgentConfig } from "@breatic/core";
import { ConflictError } from "@breatic/core";
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
interface ConsolidationData {
  conversationUpdate: string;
  projectUpdate?: string;
  historyEntry: string;
}

/**
 * Persist consolidation results across both layers.
 *
 * Always updates conversation memory and appends a history entry.
 * Optionally updates the writer's project memory with optimistic locking;
 * a lost version race leaves that layer alone.
 * @param userId - The current user's ID
 * @param conversationId - The conversation being consolidated
 * @param projectId - The associated project ID (may be undefined)
 * @param data - Consolidation payloads from the LLM rewriter
 */
export async function applyConsolidation(
  userId: string,
  conversationId: string,
  projectId: string | undefined,
  data: ConsolidationData,
): Promise<void> {
  await memoryRepo.upsertConversationMemory(
    conversationId,
    data.conversationUpdate,
  );
  await memoryRepo.appendHistory(conversationId, data.historyEntry);

  if (data.projectUpdate && projectId) {
    await memoryRepo.appendProjectEntry(
      projectId,
      userId,
      data.projectUpdate,
      conversationId,
    );
    try {
      const version = await memoryRepo.getProjectMemoryVersion(
        userId,
        projectId,
      );
      await memoryRepo.upsertProjectMemory(
        userId,
        projectId,
        data.projectUpdate,
        version,
      );
    } catch (error: unknown) {
      if (error instanceof ConflictError) {
        // Another consolidation of this member's memory landed first. Its
        // content came from the same conversations, so the row already says
        // what this one would have written.
      } else {
        throw error;
      }
    }
  }
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
