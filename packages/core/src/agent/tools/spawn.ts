/**
 * Spawn tool — delegate independent sub-tasks to a named sub-agent.
 *
 * Each sub-agent has its own role definition (from agents/*.md), tools,
 * model, and optional skill context. It inherits memory and compressed
 * conversation history from the request context (AsyncLocalStorage).
 *
 * SubAgent deducts its own credits directly — no text-based hack needed.
 *
 * @module
 */

import { tool, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { getModel, resolveProvider } from "../llm.js";
import { getAgent, listAgents } from "../agent-loader.js";
import { getSkillRegistry } from "../skills-loader.js";
import { tryGetContext } from "../../infra/request-context.js";
import { env } from "../../config/env.js";
import * as creditService from "../../modules/credit.service.js";
import { logger } from "../../logger.js";

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
    const { buildToolSet } = await import("./index.js");

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
      } else {
        logger.warn({ agentName, skillName }, "Spawn: skill not found");
      }
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

    logger.info({
      task: task.slice(0, 100),
      agent: agentName,
      skills: skillNames,
      model: agentDef.model,
      toolCount: Object.keys(tools).length,
      hasContext: !!reqCtx,
    }, "SubAgent spawned");

    const result = await generateText({
      model: getModel(agentDef.model),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(15),
      temperature: 0.3,
    });

    const totalTokens = result.usage?.totalTokens ?? 0;

    // Deduct credits directly (no text hack)
    if (reqCtx && totalTokens > 0) {
      try {
        const credits = Math.ceil((totalTokens / 1000) * env.CREDIT_MULTIPLIER);
        await creditService.deduct(
          reqCtx.userId,
          credits,
          `SubAgent:${agentName}`,
          reqCtx.conversationId,
          { tokensUsed: totalTokens, model: agentDef.model, provider: resolveProvider(agentDef.model) },
        );
        logger.info({ agent: agentName, tokens: totalTokens, credits }, "SubAgent credits deducted");
      } catch (err) {
        logger.warn({ err, agent: agentName }, "SubAgent credit deduction failed");
      }
    }

    logger.info(
      { agent: agentName, steps: result.steps?.length ?? 0, tokens: totalTokens, model: agentDef.model },
      "SubAgent completed",
    );

    return result.text || "Sub-agent completed with no text output.";
  },
});
