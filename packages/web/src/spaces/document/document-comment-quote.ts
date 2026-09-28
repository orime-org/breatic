// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finding a run of words again in a body that changed, the way web
 * annotations are re-anchored (#18, design §9.4).
 *
 * The words, a little of what stood before and after them, and how far into
 * the body they started are what is kept (W3C Web Annotation's
 * TextQuoteSelector and TextPositionSelector). Every run of the body close
 * enough to the words is a candidate, and each is scored on how alike it is
 * to them, to what stood around them, and how near it lies to where they
 * were. The search and the weights are those of the Hypothesis client's
 * `src/annotator/anchoring/match-quote.ts` (Copyright (c) 2013-2019
 * Hypothes.is Project and contributors, BSD-2-Clause).
 */

import approxSearch from 'approx-string-match';

/** How much of what stood around the words is kept, each side. */
export const QUOTE_CONTEXT_LENGTH = 32;

/** The words a range covered, and where they stood. */
export interface Quote {
  /** The words, run together across lines. */
  readonly exact: string;
  /** What stood right before them. */
  readonly prefix: string;
  /** What stood right after them. */
  readonly suffix: string;
  /** How far into the body's letters they started. */
  readonly start: number;
}

/** A run of the body that may be the words. */
export interface QuoteCandidate {
  /** Where it starts in the body's letters. */
  readonly start: number;
  /** Where it ends in the body's letters. */
  readonly end: number;
}

/** Weights from `match-quote.ts`: the words themselves count most. */
const QUOTE_WEIGHT = 50;
const PREFIX_WEIGHT = 20;
const SUFFIX_WEIGHT = 20;
const POSITION_WEIGHT = 2;

/**
 * Every run of the text within a number of edits of a string: the exact ones
 * when there are any, otherwise the close ones.
 * @param text - Where to look.
 * @param str - What to look for.
 * @param maxErrors - How many edits a run may be away from it.
 * @returns The runs, with how many edits each is away.
 */
function search(
  text: string,
  str: string,
  maxErrors: number,
): readonly { start: number; end: number; errors: number }[] {
  const exact: { start: number; end: number; errors: number }[] = [];
  for (let at = text.indexOf(str); at !== -1; at = text.indexOf(str, at + 1)) {
    exact.push({ start: at, end: at + str.length, errors: 0 });
  }
  return exact.length > 0 ? exact : approxSearch(text, str, maxErrors);
}

/**
 * How alike two strings are.
 * @param text - One.
 * @param str - The other, which the likeness is measured against.
 * @returns From 0, nothing alike, to 1, the same.
 */
function likeness(text: string, str: string): number {
  if (str.length === 0 || text.length === 0) return 0;
  const [best] = search(text, str, str.length);
  return best === undefined ? 0 : 1 - best.errors / str.length;
}

/**
 * The runs of a body that may be a quote's words, best first.
 * @param text - The body's letters.
 * @param quote - The words and where they stood.
 * @returns Every run close enough to the words, ordered by score.
 */
export function rankQuoteCandidates(
  text: string,
  quote: Quote,
): readonly QuoteCandidate[] {
  if (quote.exact.length === 0) return [];
  const maxErrors = Math.min(256, quote.exact.length / 2);
  const scored = search(text, quote.exact, maxErrors).map((match) => {
    const before = text.slice(
      Math.max(0, match.start - quote.prefix.length),
      match.start,
    );
    const after = text.slice(match.end, match.end + quote.suffix.length);
    const score =
      QUOTE_WEIGHT * (1 - match.errors / quote.exact.length) +
      PREFIX_WEIGHT * (quote.prefix === '' ? 1 : likeness(before, quote.prefix)) +
      SUFFIX_WEIGHT * (quote.suffix === '' ? 1 : likeness(after, quote.suffix)) +
      POSITION_WEIGHT *
        (1 - Math.abs(match.start - quote.start) / Math.max(1, text.length));
    return { start: match.start, end: match.end, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ start, end }) => ({ start, end }));
}
