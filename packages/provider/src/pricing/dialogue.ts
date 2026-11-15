// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A dialogue run's script as the upstream's turns (#1521). The runner sends these turns, and a binding's limits read
 * the same turns, in the browser too, so a limit on a turn counts what the turn holds.
 */

import { z } from "zod";

/** How a `Name: line` script becomes the upstream's list of turns when the run names its speakers. */
export const dialogueSchema = z.strictObject({
  /** Our items param listing the speakers; the script becomes turns only when it holds at least one named speaker. */
  speakers: z.string().min(1),
  /** The sub-field of a speaker holding the name the script's lines start with. */
  name: z.string().min(1),
  /** The upstream field the turns go under. */
  field: z.string().min(1),
  /** The sub-field of a turn naming its speaker. */
  speaker_field: z.string().min(1),
  /** The sub-field of a turn holding its words. */
  text_field: z.string().min(1),
});

/** A binding's dialogue rule. */
export type Dialogue = z.infer<typeof dialogueSchema>;

/**
 * The names of the run's speakers, as the run sends them, when the binding sends dialogue as turns.
 * @param dialogue - The binding's dialogue rule.
 * @param params - The run's params; untrusted collaborative data.
 * @returns The names in order, empty when the run names none.
 */
function speakerNames(dialogue: Dialogue, params: Record<string, unknown>): string[] {
  const speakers = params[dialogue.speakers];
  if (!Array.isArray(speakers)) return [];
  return speakers.flatMap((item: unknown) => {
    const name = typeof item === "object" && item !== null ? (item as Record<string, unknown>)[dialogue.name] : undefined;
    return typeof name === "string" && name !== "" ? [name] : [];
  });
}

/**
 * A `Name: line` script as the upstream's turns: each non-blank line goes to the speaker whose name and a
 * half-width colon start it (the longest such name), else whole to the first speaker. The script is the one
 * `dialogueText` in `@breatic/shared` writes: one line per turn, no line break inside a line, each name trimmed;
 * a turn names its speaker as the speakers list does, so the upstream pairs the two.
 * @param dialogue - The binding's dialogue rule.
 * @param script - The prompt.
 * @param names - The speakers' names, at least one.
 * @returns The turns, in order.
 */
function turnsOf(dialogue: Dialogue, script: string, names: readonly string[]): Record<string, string>[] {
  const longestFirst = [...names].sort((a, b) => b.trim().length - a.trim().length);
  return script.split("\n").flatMap((raw) => {
    const line = raw.trim();
    if (line === "") return [];
    const name = longestFirst.find((each) => line.startsWith(`${each.trim()}: `));
    const text = name === undefined ? line : line.slice(name.trim().length + 2).trim();
    return [{ [dialogue.speaker_field]: name ?? names[0]!, [dialogue.text_field]: text }];
  });
}

/**
 * The turns a run's script is sent as, when the binding sends dialogue as turns and the run names its speakers.
 * @param dialogue - The binding's dialogue rule.
 * @param params - The run's params; untrusted collaborative data.
 * @param script - The prompt as the upstream is sent it.
 * @returns The turns, or undefined when the run names no speaker.
 */
export function dialogueTurns(dialogue: Dialogue, params: Record<string, unknown>, script: string): Record<string, string>[] | undefined {
  const names = speakerNames(dialogue, params);
  return names.length === 0 ? undefined : turnsOf(dialogue, script, names);
}
