// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How typing after a trigger narrows the slash menu (inner#1125 design 5.3).
 */

/**
 * The entries whose names hold the query, in the order given. Each entry is
 * matched against every name it has (the interface language's and the
 * English one), ignoring case.
 * @param ids - The entries, in menu order.
 * @param query - What is typed after the trigger.
 * @param namesOf - The names of an entry.
 * @returns The entries that match.
 */
export function filterInsertEntries<Id extends string>(
  ids: readonly Id[],
  query: string,
  namesOf: (id: Id) => readonly string[],
): Id[] {
  const wanted = query.toLocaleLowerCase();
  if (wanted === '') return [...ids];
  return ids.filter((id) => namesOf(id).some((name) => name.toLocaleLowerCase().includes(wanted)));
}

/** The query as the menu sees it, and whether an input method is composing. */
interface ComposingQuery {
  /** The text from the trigger to the caret. */
  readonly query: string;
  /** Whether an input method composition is in progress. */
  readonly composing: boolean;
  /** The query as it stood when the composition began. */
  readonly before: string;
}

/**
 * The query the menu filters by. While an input method composes, its pinyin
 * or kana sits in the document; filtering by it would empty the menu, so the
 * query from before the composition stands until it ends.
 * @param state - The query and the composition.
 * @returns The query to filter by.
 */
export function queryWhileComposing(state: ComposingQuery): string {
  return state.composing ? state.before : state.query;
}

/** What the close rule reads. */
interface NoMatchState {
  /** The query filtered by. */
  readonly query: string;
  /** Whether it matched any entry. */
  readonly matched: boolean;
  /** The length of the last query that matched. */
  readonly lastUsefulLength: number;
  /** Whether an input method composition is in progress. */
  readonly composing: boolean;
}

/**
 * Whether the menu closes because the query has run past every name: more
 * than three characters beyond the last query that matched, as BlockNote's
 * own menu does. Never while composing.
 * @param state - The query and what it matched.
 * @returns True when the menu closes.
 */
export function closesForNoMatch(state: NoMatchState): boolean {
  if (state.composing || state.matched) return false;
  return state.query.length - state.lastUsefulLength > 3;
}
