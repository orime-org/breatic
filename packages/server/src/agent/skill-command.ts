// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The turn text a skill command sends.
 *
 * Its own module because both the route and the agent need it: the route
 * measures the ceiling on what actually goes, and the agent sends it. Living
 * in `main-agent.ts` would tie the route's input check to a module the
 * route's own tests replace wholesale.
 */

/**
 * Write the command around what the reader typed.
 *
 * The input is one part of the turn. A ceiling checked against the input
 * alone admits a turn longer than the limit by the length of the command.
 * @param skillName - The skill being invoked.
 * @param userInput - What the reader typed after it.
 * @returns The finished text of the turn.
 */
export function skillCommandText(skillName: string, userInput: string): string {
  return `/skill ${skillName} ${userInput}`;
}
