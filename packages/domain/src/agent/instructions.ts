// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The system prompt, split where a new conversation stops reading the same
 * text as every other conversation of its project.
 */
export interface Instructions {
  /** The base prompt and the project's memory. */
  shared: string;
  /** This conversation's memory, when it has any. */
  conversation?: string;
}

/**
 * The system prompt as one text, the way the model reads it.
 * @param instructions - The two parts.
 * @returns The parts joined in order.
 */
export function instructionsText(instructions: Instructions): string {
  return instructions.conversation === undefined
    ? instructions.shared
    : `${instructions.shared}\n\n${instructions.conversation}`;
}
