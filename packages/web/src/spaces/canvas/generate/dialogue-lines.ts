// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Who says each line of a dialogue, and the typed name a line drops
 * (inner#1825 design 8.5).
 *
 * On the dialogue side a line's speaker is picked, never typed: a line that
 * starts with a speaker's name and a colon (half-width or full-width) goes to
 * that speaker with the prefix taken off. That covers nodes written before
 * the lines existed, a pasted script and a collaborator's write alike. A line
 * with no speaker reads the previous line's, as `lineSpeakers` does. While
 * the user is still typing the prefix (nothing but the name and colon yet)
 * the line is left as typed, so the space after the colon goes with the name
 * once the words begin.
 */

import { planDialogueLines as planLines, typedSpeaker, type DialogueLine, type LinePlan } from '@breatic/shared';

export type { LinePlan } from '@breatic/shared';

/** How a line's typed prefix is read. */
export interface PlanOptions {
  /** Leave a line holding only a name and colon as it is, for the user still typing. */
  readonly waitForWords?: boolean;
}

/**
 * Each line's speaker and the prefix it drops, as shared `planDialogueLines`
 * reads them, with the user still typing a prefix left alone on request.
 * @param lines - The lines as they stand.
 * @param names - The speakers' names, from speaker 1.
 * @param options - How a typed prefix is read.
 * @returns One plan per line; applying it and planning again strips nothing.
 */
export function planDialogueLines(lines: readonly DialogueLine[], names: readonly string[], options: PlanOptions = {}): LinePlan[] {
  if (options.waitForWords !== true) return planLines(lines, names);
  // A line holding nothing but its prefix is planned as if it had none.
  return planLines(
    lines.map((line) => (typedSpeaker(line.text, names)?.strip === line.text.length ? { ...line, text: '' } : line)),
    names,
  );
}
