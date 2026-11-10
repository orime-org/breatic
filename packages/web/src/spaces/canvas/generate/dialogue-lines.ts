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

import { lineSpeakers, type DialogueLine } from '@breatic/shared';

/** What a line becomes: its speaker, from 1, and how many leading characters to drop. */
export interface LinePlan {
  readonly speaker: number;
  readonly strip: number;
}

/** How a line's typed prefix is read. */
export interface PlanOptions {
  /** Leave a line holding only a name and colon as it is, for the user still typing. */
  readonly waitForWords?: boolean;
}

/**
 * The speaker a line's typed prefix names, and the prefix's length.
 * @param text - The line's words.
 * @param names - The speakers' names, from speaker 1.
 * @param waitForWords - Whether a prefix with nothing after it is left alone.
 * @returns The speaker and the prefix length, or null when the line starts with no name and colon.
 */
function typedSpeaker(text: string, names: readonly string[], waitForWords: boolean): { speaker: number; strip: number } | null {
  let best: { speaker: number; strip: number; length: number } | null = null;
  for (const [at, raw] of names.entries()) {
    const name = raw.trim();
    if (name === '' || !text.startsWith(name) || (best !== null && best.length >= name.length)) continue;
    const colon = /^\s*[:\uFF1A]\s*/.exec(text.slice(name.length));
    if (colon && !(waitForWords && name.length + colon[0].length === text.length)) best = { speaker: at + 1, strip: name.length + colon[0].length, length: name.length };
  }
  return best === null ? null : { speaker: best.speaker, strip: best.strip };
}

/**
 * Each line's speaker and the prefix it drops.
 * @param lines - The lines as they stand.
 * @param names - The speakers' names, from speaker 1.
 * @param options - How a typed prefix is read.
 * @returns One plan per line; applying it and planning again strips nothing.
 */
export function planDialogueLines(lines: readonly DialogueLine[], names: readonly string[], options: PlanOptions = {}): LinePlan[] {
  const typed = lines.map((line) => typedSpeaker(line.text, names, options.waitForWords === true));
  const speakers = lineSpeakers(
    lines.map((line, at) => ({ text: line.text, speaker: typed[at]?.speaker ?? line.speaker })),
    names.length,
  );
  return speakers.map((speaker, at) => ({ speaker, strip: typed[at]?.strip ?? 0 }));
}
