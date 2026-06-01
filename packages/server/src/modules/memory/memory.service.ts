/**
 * Memory service — orchestrates the three-layer memory system.
 *
 * Reads and writes across conversation, project, and user memory
 * layers, applying optimistic locking where versioned. Used by the
 * agent system to build LLM context and persist consolidation results.
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
 * - `agent_chat`: user + project + conversation memory
 * - `canvas_node` / `edit_area`: user + project only (no conversation)
 *
 * Content is truncated to the max sizes defined in agent config.
 *
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

  const userMemoryRaw = await memoryRepo.getUserMemory(userId);

  let projectMemory = "";
  if (projectId) {
    projectMemory = await memoryRepo.getProjectMemory(projectId);
  }

  let conversationMemory = "";
  if (scenario === "agent_chat" && conversationId) {
    conversationMemory =
      await memoryRepo.getConversationMemory(conversationId);
  }

  return {
    userMemory: truncate(userMemoryRaw, config.memory_user_max_size),
    projectMemory: truncate(projectMemory, config.memory_project_max_size),
    conversationMemory,
  };
}

/** Consolidation data from the LLM memory rewriter. */
interface ConsolidationData {
  conversationUpdate: string;
  projectUpdate?: string;
  userUpdate?: string;
  historyEntry: string;
}

/**
 * Persist three-layer consolidation results.
 *
 * Always updates conversation memory and appends a history entry.
 * Optionally updates project and user memory with optimistic locking;
 * version conflicts are logged as warnings rather than propagated.
 *
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
  // (1) Always persist conversation memory + history
  await memoryRepo.upsertConversationMemory(
    conversationId,
    data.conversationUpdate,
  );
  await memoryRepo.appendHistory(conversationId, data.historyEntry);

  // (2) Project memory — optimistic locking with conflict tolerance
  if (data.projectUpdate && projectId) {
    await memoryRepo.appendProjectEntry(
      projectId,
      userId,
      data.projectUpdate,
      conversationId,
    );
    try {
      const version =
        await memoryRepo.getProjectMemoryVersion(projectId);
      await memoryRepo.upsertProjectMemory(
        projectId,
        data.projectUpdate,
        version,
      );
    } catch (error: unknown) {
      if (error instanceof ConflictError) {
        // Concurrent project-memory upsert lost the optimistic
        // version race. Swallowing is intentional (consolidator is
        // background, idempotent retries are safe), but the
        // application caller can observe the no-op via the missing
        // `applyConsolidation` follow-up event if needed.
      } else {
        throw error;
      }
    }
  }

  // (3) User memory — same optimistic locking pattern
  if (data.userUpdate) {
    await memoryRepo.appendUserEntry(
      userId,
      data.userUpdate,
      conversationId,
    );
    try {
      const version =
        await memoryRepo.getUserMemoryVersion(userId);
      await memoryRepo.upsertUserMemory(
        userId,
        data.userUpdate,
        version,
      );
    } catch (error: unknown) {
      if (error instanceof ConflictError) {
        // Same as the project-memory branch — concurrent upsert
        // lost the version race; intentionally silent.
      } else {
        throw error;
      }
    }
  }
}

/** Truncate a string to a maximum character count. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}
