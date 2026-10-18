// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place an agent's three things are decided: model, instructions,
 * tools.
 *
 * The chat turn is its one caller. It runs inside a request, and the tool set
 * is built per call: the proposal tool's description quotes the template
 * prompts in the request's language.
 *
 * Execution, step ceilings and temperature stay with the caller, which makes
 * its own model call with this config.
 */
import type { Tool } from "ai";
import { getAgentConfig } from "@breatic/core";
import type { MemoryContext } from "@breatic/shared";
import type { Instructions } from "@domain/agent/instructions.js";
import {
  BASELINE_TOOLS,
  CANVAS_TOOLS,
  buildToolSet,
  type ToolContext,
} from "@domain/agent/tools/index.js";

/** What a caller tells the factory about the run it is about to start. */
export interface AgentConfigRequest {
  /**
   * The base system prompt, already assembled by the caller.
   *
   * Passed in rather than built here because what belongs in it is an
   * application decision.
   */
  basePrompt: string;
  /** The conversation and project layers, when the caller has any. */
  memoryContext?: MemoryContext;
  /** What the turn knows that a tool needs when it is built. */
  toolContext?: ToolContext;
}

/** The three things, resolved. */
export interface ResolvedAgentConfig {
  /**
   * The model identifier, not an instantiated provider.
   *
   * A string so two configs can be compared, and so the resolution stays in
   * one place.
   */
  modelId: string;
  /** The system prompt in its parts; `systemFor` decides whether they go as separate blocks. */
  instructions: Instructions;
  /** Tools, ready for the AI SDK's `tools` option. */
  tools: Record<string, Tool>;
}

/**
 * Resolve model, instructions and tools for one agent run.
 * @param request - What the caller knows about this run.
 * @returns The three things, decided in one place.
 * @throws {never} Never.
 */
export function buildAgentConfig(
  request: AgentConfigRequest,
): ResolvedAgentConfig {
  const { basePrompt, memoryContext, toolContext } = request;

  const toolNames = [...BASELINE_TOOLS, ...CANVAS_TOOLS];

  return {
    modelId: getAgentConfig().default_model,
    instructions: {
      base: basePrompt,
      ...(memoryContext?.projectMemory ? { project: `## Project Context\n${memoryContext.projectMemory}` } : {}),
      ...(memoryContext?.conversationMemory
        ? { conversation: `## Conversation Memory\n${memoryContext.conversationMemory}` }
        : {}),
    },
    tools: buildToolSet(toolNames, toolContext),
  };
}
