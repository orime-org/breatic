/**
 * Main Agent — streaming chat with AI SDK.
 *
 * Replaces the Python ToolCallRunner with AI SDK's built-in
 * `streamText()` + `maxSteps` for automatic tool-call looping.
 */

import { streamText, stepCountIs } from "ai";
import type { ModelMessage, TextPart, ImagePart } from "ai";

import { getModel, resolveProvider } from "@breatic/core";
import { buildToolSet } from "@breatic/core";
import { buildSystemPrompt } from "@server/agent/context.js";
import { getSkillRegistry } from "@breatic/core";
import { getAgentConfig } from "@breatic/core";
import { env } from "@breatic/core";
import { creditService } from "@breatic/core";
import { SSEEventType } from "@server/agent/types.js";
import type { SSEEvent } from "@server/agent/types.js";
import { conversationRepo } from "@server/modules";
import { consolidateIfNeeded } from "@server/agent/memory-consolidator.js";
import { getContext } from "@breatic/core";
import { logger } from "@breatic/core";
import { ASK_USER_SENTINEL, parseInteractionSentinel } from "@server/agent/interaction-sentinel.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * Main Agent for streaming chat interactions.
 *
 * Reads userId, conversationId, projectId, memoryContext, and compressedHistory
 * from the AsyncLocalStorage request context (set by route handler).
 */
export class MainAgent {
  private get ctx() {
    return getContext();
  }

  /**
   * Run a streaming chat turn with the user.
   *
   * @param userMessage - The user's text message
   * @param resources - Optional attached resource URLs (images, files)
   * @yields SSE events for real-time frontend rendering
   */
  async *chat(userMessage: string, resources?: string[]): AsyncGenerator<SSEEvent> {
    const { conversationId, memoryContext, compressedHistory } = this.ctx;

    // Save user message. Capture the assigned turnIndex so billing can
    // build a stable refKey (`turn:${conversationId}:${turnIndex}`) that
    // survives retries — see core/src/modules/credit.service.ts `deductOnce`.
    const turnIndex = await conversationRepo.addMessage(conversationId, {
      role: "user",
      content: userMessage,
      ts: new Date().toISOString(),
    });
    this.ctx.billing = { turnIndex, spawnCount: { value: 0 } };

    // Build system prompt (memory already loaded in route layer)
    const system = buildSystemPrompt({ memoryContext });

    // Build messages array from pre-compressed history
    const userContent = MainAgent.buildUserContent(userMessage, resources);
    const messages = [
      ...compressedHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ] as ModelMessage[];

    // Stream with AI SDK
    yield* this.runStream(system, messages);
  }

  /**
   * Execute a skill command (e.g. `/skill generate_image_plan ...`).
   *
   * @param skillName - Name of the skill to invoke
   * @param userInput - User's input text for the skill
   * @param resources - Optional attached resources
   * @yields SSE events
   */
  async *handleSkillCommand(
    skillName: string,
    userInput: string,
    resources?: string[],
  ): AsyncGenerator<SSEEvent> {
    const { conversationId, memoryContext, compressedHistory } = this.ctx;
    const registry = getSkillRegistry();
    const skill = registry.get(skillName);

    if (!skill) {
      yield this.sse(SSEEventType.ERROR, { message: `Skill '${skillName}' not found` });
      return;
    }

    // Save user command. Capture the assigned turnIndex for billing refKey,
    // same reason as `chat()` above.
    const turnIndex = await conversationRepo.addMessage(conversationId, {
      role: "user",
      content: `/skill ${skillName} ${userInput}`,
      ts: new Date().toISOString(),
    });
    this.ctx.billing = { turnIndex, spawnCount: { value: 0 } };

    // Build system prompt with skill context (memory from request context)
    const instructions = registry.loadSkillContent(skillName);
    const basePrompt = buildSystemPrompt({ memoryContext });
    const system = `${basePrompt}\n\n## Active Skill: ${skillName}\n${instructions}`;

    const userContent = MainAgent.buildUserContent(
      `/skill ${skillName} ${userInput}`,
      resources,
    );
    const messages = [
      ...compressedHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ] as ModelMessage[];

    // Use skill-declared tools instead of defaults
    yield* this.runStream(system, messages, skill.tools);
  }

  /**
   * Core streaming loop using AI SDK `streamText()`.
   *
   * AI SDK handles the tool-call iteration automatically via `maxSteps`.
   */
  private async *runStream(
    system: string,
    messages: ModelMessage[],
    toolNames?: string[],
  ): AsyncGenerator<SSEEvent> {
    const { userId, conversationId, projectId } = this.ctx;
    const agentCfg = getAgentConfig();
    const tools = buildToolSet(toolNames ?? []);

    const result = streamText({
      model: getModel(agentCfg.default_model),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(agentCfg.max_tool_iterations),
      temperature: 0.2,
    });

    let fullResponse = "";
    let thinkingContent = "";
    const toolCallLog: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          fullResponse += part.text;
          yield this.sse(SSEEventType.CHAT_CHUNK, { text: part.text });
          break;

        case "reasoning-delta":
          thinkingContent += part.text;
          break;

        case "tool-call":
          toolCallLog.push({
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.input as Record<string, unknown>,
          });
          yield this.sse(SSEEventType.AGENT_TOOL_HINT, { hint: part.toolName });
          break;

        case "tool-result": {
          const toolCall = toolCallLog.find((tc) => tc.id === part.toolCallId);

          // Stringify output once; reused for sentinel detection,
          // interaction-tool payload parse, and the `role: 'tool'`
          // history message that the LLM sees on subsequent turns.
          const output = "output" in part ? part.output : undefined;
          const resultStr = typeof output === "string" ? output : JSON.stringify(output);

          // Pre-parse interaction-tool payload BEFORE persisting so the
          // structured result lands on the assistant `tool_calls[0].result`
          // record. History reload reads that field directly — sentinel
          // decoding stays a backend protocol concern and never leaks
          // into the frontend persistence boundary.
          const interaction = parseInteractionSentinel(resultStr);

          if (toolCall) {
            await conversationRepo.addMessage(conversationId, {
              role: "assistant",
              content: "",
              ts: new Date().toISOString(),
              tool_calls: [
                interaction ? { ...toolCall, result: interaction.payload } : toolCall,
              ],
            });
            await conversationRepo.addMessage(conversationId, {
              role: "tool",
              content: resultStr,
              ts: new Date().toISOString(),
              tool_call_id: part.toolCallId,
              name: toolCall.name,
            });
          }

          if (resultStr.startsWith(ASK_USER_SENTINEL)) {
            try {
              const payload = JSON.parse(resultStr.slice(ASK_USER_SENTINEL.length)) as Record<string, unknown>;
              yield this.sse(SSEEventType.AGENT_ASK, payload);
            } catch {
              yield this.sse(SSEEventType.AGENT_ASK, { question: resultStr });
            }
            return;
          }

          if (interaction) {
            yield this.sse(interaction.event, interaction.payload);
            return;
          }
          break;
        }
      }
    }

    // Save assistant final response (with thinking if present)
    if (fullResponse) {
      await conversationRepo.addMessage(conversationId, {
        role: "assistant",
        content: fullResponse,
        ts: new Date().toISOString(),
        ...(thinkingContent ? { thinking: thinkingContent } : {}),
      });
    }

    // Trigger memory consolidation (fire-and-forget, non-blocking)
    consolidateIfNeeded(userId, conversationId, projectId)
      .catch((err) => logger.warn({ err }, "Memory consolidation failed"));

    // Deduct credits for MainAgent tokens only. SubAgents deduct their own
    // via RequestStore.billing.spawnCount (see spawnTool). Using
    // `deductOnce` with the turn-scoped refKey ensures this billing is
    // idempotent: an SSE reconnect or handler re-entry on the same turn
    // won't double-charge.
    let creditsUsed = 0;
    try {
      const usage = await result.usage;
      const mainTokens = usage?.totalTokens ?? 0;

      if (mainTokens > 0) {
        creditsUsed = Math.ceil((mainTokens / 1000) * env.CREDIT_MULTIPLIER);
        const billingTurnIndex = this.ctx.billing?.turnIndex;
        if (billingTurnIndex === undefined) {
          // Should be set by chat()/handleSkillCommand() before we reach here.
          throw new Error("MainAgent.runStream: billing.turnIndex not initialized");
        }
        await creditService.deductOnce(
          userId,
          `turn:${conversationId}:${billingTurnIndex}`,
          creditsUsed,
          "Agent chat",
          {
            tokensUsed: mainTokens,
            model: agentCfg.default_model,
            provider: resolveProvider(agentCfg.default_model),
          },
        );
      }
    } catch {
      logger.warn({ userId, creditsUsed }, "Agent chat credit deduction failed");
    }

    logger.info({
      userId,
      conversationId,
      responseLength: fullResponse.length,
      creditsUsed,
    }, "agent_response");

    // Extract plan
    const plan = MainAgent.extractPlan(fullResponse);
    if (plan) {
      yield this.sse(SSEEventType.CHAT_PLAN, plan);
    }

    yield this.sse(SSEEventType.CHAT_DONE, {
      conversationId,
      creditsUsed,
    });
  }

  /** Build an SSE event with user_id and project_id injected. */
  private sse(event: SSEEventType, data: Record<string, unknown>): SSEEvent {
    const { userId, projectId } = this.ctx;
    return {
      event,
      data: {
        ...data,
        user_id: userId,
        project_id: projectId ?? null,
      },
    };
  }

  /**
   * Build multimodal user content from text + resource URLs.
   *
   * @param text - User's text message
   * @param resources - Optional attached resource URLs
   * @returns Plain string or multimodal content array
   */
  static buildUserContent(text: string, resources?: string[]): string | Array<TextPart | ImagePart> {
    if (!resources?.length) return text;

    const parts: Array<TextPart | ImagePart> = [
      { type: "text", text },
    ];

    for (const url of resources) {
      const ext = url.slice(url.lastIndexOf(".")).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        parts.push({ type: "image", image: new URL(url) });
      } else {
        parts.push({ type: "text", text: `[Attached resource: ${url}]` });
      }
    }

    return parts;
  }

  /**
   * Extract a JSON task plan from LLM response text.
   *
   * Looks for ```json ... ``` blocks containing a plan object.
   */
  static extractPlan(text: string): Record<string, unknown> | null {
    const match = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (!match?.[1]) return null;

    try {
      const data = JSON.parse(match[1]) as Record<string, unknown>;
      if (data.ready && "plan" in data) {
        return data.plan as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — ignore
    }
    return null;
  }
}
