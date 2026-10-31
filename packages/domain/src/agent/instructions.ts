// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MemoryContext } from "@breatic/shared";

/**
 * The system prompt in the parts that end where another conversation stops
 * reading the same text: every conversation shares the base prompt, one
 * user's conversations in a project share that project's memory too, and the
 * conversation's own memory is its alone.
 */
export interface Instructions {
  /** The base prompt. */
  base: string;
  /** The project's memory, when it has any. */
  project?: string;
  /** This conversation's memory, when it has any. */
  conversation?: string;
}

/**
 * Assemble memory instructions without selecting another model or tool set.
 * @param basePrompt - The caller's base system prompt.
 * @param memoryContext - The current project and conversation memories.
 * @returns The system instructions for this assembly's memory snapshot.
 * @throws {never} Never.
 */
export function instructionsForAgentMemory(basePrompt: string, memoryContext?: MemoryContext): Instructions {
  return {
    base: basePrompt,
    ...(memoryContext?.projectMemory ? { project: `## Project Context\n${memoryContext.projectMemory}` } : {}),
    ...(memoryContext?.conversationMemory
      ? { conversation: `## Conversation Memory\n${memoryContext.conversationMemory}` }
      : {}),
  };
}

/**
 * The system prompt as one text, the way the model reads it.
 * @param instructions - The parts.
 * @returns The parts there are, joined in order.
 */
export function instructionsText(instructions: Instructions): string {
  return [instructions.base, instructions.project, instructions.conversation]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}
