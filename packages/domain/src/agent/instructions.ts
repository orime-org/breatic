// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The system prompt in the parts that end where another conversation stops
 * reading the same text: every conversation shares the base prompt, every
 * conversation of a project shares its memory too, and the conversation's own
 * memory is its alone.
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
 * The system prompt as one text, the way the model reads it.
 * @param instructions - The parts.
 * @returns The parts there are, joined in order.
 */
export function instructionsText(instructions: Instructions): string {
  return [instructions.base, instructions.project, instructions.conversation]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}
