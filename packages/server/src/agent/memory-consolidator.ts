/**
 * Memory consolidator — auto-summarize long conversations.
 *
 * When a conversation exceeds `memory_window` turns, the consolidator
 * asks an LLM to summarize old turns into the three-layer memory:
 * conversation (always), project (if relevant), user (if relevant).
 *
 * The consolidated turns are "forgotten" from the LLM context but
 * their essence is preserved in memory. Recent turns (memory_keep_recent_turns)
 * are always kept unconsolidated.
 */

import { generateText, stepCountIs } from "ai";
import { getModel } from "@breatic/core";
import { getAgentConfig } from "@breatic/core";
import { conversationRepo } from "@server/modules";
import { memoryService } from "@server/modules";
import { memoryRepo } from "@server/modules";
import { logger } from "@breatic/core";

// Model is configured via config/agent.yaml → consolidation_model

const CONSOLIDATION_PROMPT = `\
You are a memory consolidator for an AI creative assistant. Your job is to analyze conversation messages and extract key information into a structured memory update.

Current memory state:
- Conversation memory: {conversation_memory}
- User preferences: {user_memory}
- Project context: {project_memory}

Messages to consolidate:
{messages}

Produce a JSON object with these fields:
{
  "conversationUpdate": "Complete rewrite of conversation memory incorporating the new information. Be concise but preserve all important facts, decisions, and context. This replaces the entire conversation memory.",
  "projectUpdate": "New project-level insights that should be shared across conversations (creative direction, style choices, asset details). Set to null if no project-relevant insights.",
  "userUpdate": "New user preference insights (preferred styles, working patterns, communication preferences). Set to null if no new user-level insights.",
  "historyEntry": "One-line summary of what was discussed in these messages."
}

Rules:
- conversationUpdate REWRITES the full memory — incorporate existing memory + new info
- projectUpdate/userUpdate only when there are genuine cross-conversation insights
- Be concise — this text will be injected into future LLM context windows
- Respond ONLY with the JSON object, no markdown or explanation
- Respond in the same language as the messages`;

/**
 * Check if consolidation is needed and execute if so.
 *
 * Called after each MainAgent response (fire-and-forget).
 * Does nothing if the conversation is under the memory_window turn threshold.
 *
 * @param userId - Current user ID
 * @param conversationId - Current conversation ID
 * @param projectId - Associated project ID (may be undefined)
 */
export async function consolidateIfNeeded(
  userId: string,
  conversationId: string,
  projectId?: string,
): Promise<void> {
  const config = getAgentConfig();

  // Check if consolidation is needed (by turn count)
  const unconsolidatedTurns = await conversationRepo.getUnconsolidatedTurnCount(conversationId);
  if (unconsolidatedTurns <= config.memory_window) {
    return; // Under threshold, nothing to do
  }

  const conv = await conversationRepo.getConversation(conversationId);
  if (!conv) return;

  const lastTurn = conv.lastConsolidatedTurn;

  // Get messages to consolidate (old turns, excluding recent ones to keep)
  const messagesToConsolidate = await conversationRepo.getMessagesForConsolidation(
    conversationId,
    lastTurn,
    config.memory_keep_recent_turns,
  );

  if (messagesToConsolidate.length === 0) return;

  // Load existing memory context
  const existingConvMemory = await memoryRepo.getConversationMemory(conversationId);
  const existingUserMemory = await memoryRepo.getUserMemory(userId);
  const existingProjectMemory = projectId
    ? await memoryRepo.getProjectMemory(projectId)
    : "";

  // Build the consolidation prompt (skip thinking content, include tool details for quality)
  const messagesText = messagesToConsolidate
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const prompt = CONSOLIDATION_PROMPT
    .replace("{conversation_memory}", existingConvMemory || "(empty)")
    .replace("{user_memory}", existingUserMemory || "(empty)")
    .replace("{project_memory}", existingProjectMemory || "(empty)")
    .replace("{messages}", messagesText);

  // Call LLM for consolidation (temperature=0: factual extraction, no creativity)
  const result = await generateText({
    model: getModel(config.consolidation_model),
    messages: [{ role: "user" as const, content: prompt }],
    stopWhen: stepCountIs(1),
    temperature: 0,
  });

  // Parse the JSON response
  const text = result.text.trim();
  let parsed: {
    conversationUpdate: string;
    projectUpdate: string | null;
    userUpdate: string | null;
    historyEntry: string;
  };

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch (err) {
    logger.warn({ err, conversationId, responsePreview: text.slice(0, 200) }, "Memory consolidation: failed to parse LLM response");
    return;
  }

  // Apply the consolidation
  await memoryService.applyConsolidation(userId, conversationId, projectId, {
    conversationUpdate: parsed.conversationUpdate,
    projectUpdate: parsed.projectUpdate ?? undefined,
    userUpdate: parsed.userUpdate ?? undefined,
    historyEntry: parsed.historyEntry,
  });

  // Advance the consolidation pointer to the highest turn that was consolidated
  const consolidatedTurns = messagesToConsolidate.map((m) => m.turnIndex);
  const newTurn = Math.max(...consolidatedTurns);
  await conversationRepo.updateConsolidatedTurn(conversationId, Math.max(newTurn, lastTurn));

  logger.info({
    conversationId,
    messagesConsolidated: messagesToConsolidate.length,
    newConsolidatedTurn: newTurn,
    hasProjectUpdate: !!parsed.projectUpdate,
    hasUserUpdate: !!parsed.userUpdate,
  }, "Memory consolidation completed");
}
