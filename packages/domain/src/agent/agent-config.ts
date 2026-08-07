// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { getSkillRegistry } from "@domain/agent/skills-loader.js";
import { BASELINE_TOOLS, buildToolSet } from "@domain/agent/tools/index.js";

/** What a caller tells the factory about the run it is about to start. */
export interface AgentConfigRequest {
  /**
   * The skill to run, if the caller is running one.
   *
   * Omitted for plain chat, which is not a lesser case: it gets the baseline
   * tools like everyone else.
   */
  skillName?: string;
  /**
   * The base system prompt, already assembled by the caller.
   *
   * Passed in rather than built here because what belongs in it is an
   * application decision -- chat has a persona and a skill summary, a worker
   * task has neither.
   */
  basePrompt?: string;
  /** Three-layer memory, when the caller has any. Worker never does. */
  memoryContext?: MemoryContext;
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
 * @throws {Error} When `skillName` names a skill the registry does not have.
 */
export function buildAgentConfig(
  request: AgentConfigRequest,
): ResolvedAgentConfig {
  const { skillName, basePrompt, memoryContext } = request;
  const registry = getSkillRegistry();

  const skill = skillName ? registry.get(skillName) : undefined;
  if (skillName && !skill) {
    throw new Error(`Skill not found: ${skillName}`);
  }

  // A skill's declared tools are added to the baseline, never substituted
  // for it. Ten of the eleven skills declare none; substitution would leave
  // every one of them running with nothing, which is the same defect plain
  // chat had, relocated to the skill path.
  const toolNames = skill
    ? [...new Set([...BASELINE_TOOLS, ...skill.tools])]
    : [...BASELINE_TOOLS];

  const sections: string[] = [];
  if (basePrompt) sections.push(basePrompt);
  if (skillName) sections.push(registry.loadSkillContent(skillName));
  if (memoryContext?.userMemory) {
    sections.push(`## User Preferences & Style\n${memoryContext.userMemory}`);
  }
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
