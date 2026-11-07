// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { MemoryContext } from "@breatic/shared";

/**
 * The system prompt in the parts that end where another conversation stops
 * reading the same text: every conversation shares the base prompt; the
 * memory entries are shared by one user's conversations in a project while
 * none of them has entries of its own, since the index lists this
 * conversation's entries too; the progress note is this conversation's alone.
 */
export interface Instructions {
  /** The base prompt. */
  base: string;
  /** The memory entries; always there when the caller has memory, so the protocol in the base prompt has its section. */
  project?: string;
  /** This conversation's progress note, when it has one. */
  conversation?: string;
}

/**
 * The index of memory entries as the system prompt shows it (#1363):
 * migrated blocks first and in full, then one line per entry, then how many
 * were left out.
 * @param memory - The turn's memory.
 * @returns The section.
 * @throws {never} Never.
 */
function memoryEntriesSection(memory: MemoryContext): string {
  const migrated = memory.migrated.map((m) => `### ${m.id} · ${m.title}\n\n${m.content}`);
  const lines = memory.entries.map((e) => `- ${e.id} · ${e.title}`);
  const blocks = [...migrated, ...(lines.length > 0 ? [lines.join("\n")] : [])];
  if (blocks.length === 0) blocks.push("No entries yet.");
  if (memory.olderCount > 0) {
    blocks.push(
      memory.olderCount === 1
        ? "1 older entry is not listed here."
        : `${String(memory.olderCount)} older entries are not listed here.`,
    );
  }
  return `## Memory Entries\n\n${blocks.join("\n\n")}`;
}

/**
 * Assemble memory instructions without selecting another model or tool set.
 * @param basePrompt - The caller's base system prompt.
 * @param memoryContext - The turn's memory.
 * @returns The system instructions for this assembly's memory snapshot.
 * @throws {never} Never.
 */
export function instructionsForAgentMemory(basePrompt: string, memoryContext?: MemoryContext): Instructions {
  if (memoryContext === undefined) return { base: basePrompt };
  return {
    base: basePrompt,
    project: memoryEntriesSection(memoryContext),
    ...(memoryContext.progress ? { conversation: `## Conversation So Far\n\n${memoryContext.progress}` } : {}),
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
