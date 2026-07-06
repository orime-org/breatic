// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Spawn tool — delegate independent sub-tasks to a named sub-agent.
 *
 * Each sub-agent has its own role definition (from agents/*.md), tools,
 * model, and optional skill context. It inherits memory and compressed
 * conversation history from the request context (AsyncLocalStorage).
 *
 * SubAgent deducts its own credits directly — no text-based hack needed.
 * @module
 */

import { tool, stepCountIs } from "ai";
import { generateTextRetry } from "@domain/agent/model-call.js";
import { z } from "zod";
import { getModel, resolveProvider } from "@domain/agent/llm.js";
import { getAgent, listAgents } from "@domain/agent/agent-loader.js";
import { getSkillRegistry } from "@domain/agent/skills-loader.js";
import { tryGetContext } from "@breatic/core";
import { env } from "@breatic/core";
import * as creditService from "@domain/credit/credit.service.js";

const agentList = listAgents();
const agentNames = agentList.map((a) => a.name).join(", ");

const inputSchema = z.object({
  task: z.string().describe(
    "Clear, specific task description for the sub-agent. " +
    "The sub-agent inherits conversation context automatically, so focus on WHAT to do.",
  ),
  agent: z.string().describe(
    `Sub-agent role to use. Available: ${agentNames}. ` +
    "Each agent has specialized capabilities and tools.",
  ),
  skill: z.string().optional().describe(
    "Optional skill to load for additional domain knowledge. " +
    "Overrides the agent's default skills when specified.",
  ),
});

/**
 * Spawn a sub-agent to execute an independent task.
 *
 * The sub-agent inherits:
 * - Three-layer memory (user preferences, project context, conversation summary)
 * - Compressed conversation history (recent turns)
 * - userId for billing attribution
 *
 * It does NOT share the MainAgent's full system prompt or tool-call state.
 */
export const spawnTool = tool({
  description:
    "Spawn a named sub-agent to execute an independent task. " +
    `Available agents: ${agentNames}. ` +
    "Each agent has a specialized role, tools, and model. " +
    "Sub-agents inherit conversation context automatically. " +
    "Multiple spawn calls in one turn run in parallel.",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>): Promise<string> => {
    const { task, agent: agentName, skill: skillOverride } = input;

    // Load agent definition
    const agentDef = getAgent(agentName);
    if (!agentDef) {
      return `Error: Agent '${agentName}' not found. Available: ${agentNames}`;
    }

    // Lazy import to avoid circular dependency (spawn → index → spawn)
    const { buildToolSet } = await import("@domain/agent/tools/index.js");

    // Build system prompt from agent definition
    let system = agentDef.systemPrompt;

    // Inject memory context from request store (shared, cached)
    const reqCtx = tryGetContext();
    if (reqCtx?.memoryContext) {
      const { userMemory, projectMemory, conversationMemory } = reqCtx.memoryContext;
      if (userMemory) system += `\n\n## User Preferences\n${userMemory}`;
      if (projectMemory) system += `\n\n## Project Context\n${projectMemory}`;
      if (conversationMemory) system += `\n\n## Conversation Summary\n${conversationMemory}`;
    }

    // Determine which skills to load
    const skillNames = skillOverride ? [skillOverride] : [...agentDef.skills];
    const registry = getSkillRegistry();

    for (const skillName of skillNames) {
      const skill = registry.get(skillName);
      if (skill) {
        const content = registry.loadSkillContent(skillName);
        system += `\n\n## Skill: ${skillName}\n${content}`;
      }
      // Per CLAUDE.md "core/shared/domain write no logs" mandate, missing
      // skill is silent — the application caller's MainAgent path
      // can audit via the SubAgent result text if needed.
    }

    // Build tools: agent's declared tools + skill's declared tools (union), minus spawn
    const agentTools = new Set(agentDef.tools);
    for (const skillName of skillNames) {
      const skill = registry.get(skillName);
      if (skill) {
        for (const t of skill.tools) agentTools.add(t);
      }
    }
    agentTools.delete("spawn"); // Prevent recursive spawning

    const tools = buildToolSet([...agentTools]);

    // Build messages: compressed history as context + the task
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Inject compressed conversation history so SubAgent understands the discussion
    if (reqCtx?.compressedHistory && reqCtx.compressedHistory.length > 0) {
      const historyText = reqCtx.compressedHistory
        .map((m) => `[${m.role}]: ${m.content}`)
        .filter((line) => line.length > 10) // Skip empty tool-call messages
        .join("\n");

      if (historyText.length > 0) {
        messages.push({
          role: "user",
          content: `Here is the recent conversation context for reference:\n\n${historyText}\n\n---\n\nNow, your task:`,
        });
        messages.push({
          role: "assistant",
          content: "Understood. I have the conversation context. I'll now work on the task.",
        });
      }
    }

    // The actual task
    messages.push({ role: "user", content: task });

    const result = await generateTextRetry({
      model: getModel(agentDef.model),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(15),
      temperature: 0.3,
    });

    const totalTokens = result.usage?.totalTokens ?? 0;

    // Deduct credits idempotently. `deductOnce` uses a refKey scoped to
    // (conversation, turn, spawn index). `spawnCount.value++` assigns a
    // stable index per spawn invocation in this turn — if the same turn is
    // somehow retried (e.g. worker re-execution), the Nth spawn's refKey
    // matches and the charge is skipped on replay.
    //
    // `billing` is set by MainAgent at turn start. If missing, we're in a
    // code path that bypassed MainAgent (a test harness, or a future entry
    // point that hasn't wired billing); skip the charge rather than crash.
    // Deduct credits idempotently. `deductOnce` uses a refKey scoped
    // to (conversation, turn, spawn index). Per the CLAUDE.md
    // "core/shared/domain write no logs" mandate, missing billing
    // context throws —
    // the MainAgent caller catches and decides whether to abort the
    // SubAgent turn or proceed without billing. Credit deduction
    // errors propagate (rather than warn-and-continue) so the
    // application layer can observe + audit billing failures
    // consistently with the rest of the credit code path.
    if (reqCtx && totalTokens > 0) {
      const credits = Math.ceil((totalTokens / 1000) * env.CREDIT_MULTIPLIER);
      const billing = reqCtx.billing;
      if (!billing) {
        throw new Error(
          `SubAgent '${agentName}': billing context missing — cannot deduct credits`,
        );
      }
      const spawnIdx = billing.spawnCount.value++;
      await creditService.deductOnce(
        reqCtx.userId,
        `spawn:${reqCtx.conversationId}:${billing.turnIndex}:${spawnIdx}`,
        credits,
        `SubAgent:${agentName}`,
        { tokensUsed: totalTokens, model: agentDef.model, provider: resolveProvider(agentDef.model) },
      );
    }

    return result.text || "Sub-agent completed with no text output.";
  },
});
