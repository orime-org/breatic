// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place an agent's three things are decided: model, instructions,
 * tools.
 *
 * Three call sites used to assemble these independently and had drifted on
 * seven separate values -- which model, whether the base prompt was included,
 * whether memory was, where memory's section headings came from, how many
 * steps were allowed, what temperature, and what a caller with no tools of
 * its own received. Some of those differences were deliberate once and
 * nobody could tell which.
 *
 * What stays out of here, deliberately:
 *
 * - Execution. Streaming and non-streaming are different calls with different
 *   return shapes, and a factory that tried to cover both would hand back a
 *   union every caller has to narrow. Callers take this config and make their
 *   own call.
 * - Step ceilings and temperature. Those are execution parameters, and the
 *   two paths legitimately differ: chat has a person waiting and can afford
 *   more turns, a worker task is a bounded job.
 * - Anything read from AsyncLocalStorage. Worker has no request context, so a
 *   factory that reached for one would work in chat and throw in worker.
 *   Everything comes in through the argument.
 */
import type { Tool } from "ai";
import { getAgentConfig } from "@breatic/core";
import type { MemoryContext } from "@breatic/shared";
import {
  BASELINE_TOOLS,
  CANVAS_TOOLS,
  INTERACTION_TOOLS,
  buildToolSet,
} from "@domain/agent/tools/index.js";

/** What a caller tells the factory about the run it is about to start. */
export interface AgentConfigRequest {
  /**
   * The base system prompt, already assembled by the caller.
   *
   * Passed in rather than built here because what belongs in it is an
   * application decision.
   */
  basePrompt?: string;
  /** The conversation and project layers, when the caller has any. Worker never does. */
  memoryContext?: MemoryContext;
  /**
   * Whether this caller can render an interaction tool's payload.
   *
   * The four interaction tools return a sentinel-prefixed string that the
   * SSE loop decodes into an event the frontend draws. A caller without that
   * loop — worker, running a task with nobody watching — would hand the
   * model a tool that asks the user a question and then let the raw sentinel
   * stand as the answer. Such a caller does not get them.
   */
  interactive?: boolean;
}

/** The three things, resolved. */
export interface ResolvedAgentConfig {
  /**
   * The model identifier, not an instantiated provider.
   *
   * A string so two configs can be compared, and so the resolution stays in
   * one place: worker used to call `getModel()` with no argument and land on
   * a literal that happened to match `agent.yaml` without being read from it.
   */
  modelId: string;
  /** The full system prompt. */
  instructions: string;
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
  const { basePrompt, memoryContext } = request;

  // The baseline and the tools about the spaces in front of the reader.
  const merged = [...BASELINE_TOOLS, ...CANVAS_TOOLS];
  // A caller with no reader must not be offered a tool that puts something in
  // front of nobody.
  const toolNames = request.interactive
    ? merged
    : merged.filter((n) => !INTERACTION_TOOLS.includes(n));

  const sections: string[] = [];
  if (basePrompt) sections.push(basePrompt);
  if (memoryContext?.projectMemory) {
    sections.push(`## Project Context\n${memoryContext.projectMemory}`);
  }
  if (memoryContext?.conversationMemory) {
    sections.push(`## Conversation Memory\n${memoryContext.conversationMemory}`);
  }

  return {
    modelId: getAgentConfig().default_model,
    instructions: sections.join("\n\n"),
    tools: buildToolSet(toolNames),
  };
}
