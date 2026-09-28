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
): readonly CloseRun[] {
  const exact: CloseRun[] = [];
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

/** A run close to the words, and how many edits it is from them. */
interface CloseRun {
  readonly start: number;
  readonly end: number;
  readonly errors: number;
}

/** Stands in for text already looked at; never a letter of the body. */
const SEEN = '\u0000';

/**
 * Finds a quote's words in a body: the best-scoring run close enough to them
 * that the caller accepts.
 *
 * The closest runs are scored first. When the caller accepts none of them,
 * they are blanked out of the search and the next closest are scored, until
 * a run is accepted or none is left within half the words' length of edits:
 * `approx-string-match` hands back only the closest runs, so a caller that
 * turns those down would otherwise never see the next ones.
 * @param text - The body's letters.
 * @param quote - The words and where they stood.
 * @param accept - Whether a run can be the words.
 * @returns The run taken, or null when none is accepted.
 */
export function findQuote(
  text: string,
  quote: Quote,
  accept: (candidate: QuoteCandidate) => boolean,
): QuoteCandidate | null {
  if (quote.exact.length === 0) return null;
  const maxErrors = Math.min(256, quote.exact.length / 2);
  let searched = text;
  for (;;) {
    const matches = search(searched, quote.exact, maxErrors);
    if (matches.length === 0) return null;
    const ranked = matches
      .map((match) => ({
        start: match.start,
        end: match.end,
        score: scoreOf(text, quote, match),
      }))
      .sort((a, b) => b.score - a.score);
    const taken = ranked.find((candidate) => accept(candidate));
    if (taken !== undefined) return { start: taken.start, end: taken.end };
    for (const match of matches) {
      searched =
        searched.slice(0, match.start) +
        SEEN.repeat(match.end - match.start) +
        searched.slice(match.end);
    }
  }
}

/**
 * How well a run matches a quote, weighted the way `match-quote.ts` weighs it.
 * @param text - The body's letters.
 * @param quote - The words and where they stood.
 * @param match - The run, with how many edits it is from the words.
 * @returns The score; higher is better.
 */
function scoreOf(text: string, quote: Quote, match: CloseRun): number {
  const before = text.slice(
    Math.max(0, match.start - quote.prefix.length),
    match.start,
  );
  const after = text.slice(match.end, match.end + quote.suffix.length);
  return (
    QUOTE_WEIGHT * (1 - match.errors / quote.exact.length) +
    PREFIX_WEIGHT * (quote.prefix === '' ? 1 : likeness(before, quote.prefix)) +
    SUFFIX_WEIGHT * (quote.suffix === '' ? 1 : likeness(after, quote.suffix)) +
    POSITION_WEIGHT *
      (1 - Math.abs(match.start - quote.start) / Math.max(1, text.length))
  );
}
