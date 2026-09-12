// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  applyTabMove,
  initialOpenTabIds,
  sameTabOrder,
  type TabOrderEntry,
} from '@breatic/shared';

/**
 * The tab bar, as this one browser tab holds it.
 *
 * Nothing here is stored or shared: opening a project starts from the newest
 * Space every time (user 2026-09-12), two browser tabs on the same account
 * each keep their own, and closing the page forgets it.
 */
export interface TabState {
  /** False until the meta document has synced, when `spaces` cannot be read yet. */
  ready: boolean;
  /** The tabs on the strip, in the order they are painted. */
  openIds: ReadonlyArray<string>;
  /** The tab whose Space the page is showing, null only when the strip is empty. */
  activeId: string | null;
}

/** Everything that can move the tab bar. */
export type TabAction =
  /** The live Spaces, as a whole. First arrival opens the newest one; later ones drop tabs whose Space is gone. */
  | { type: 'spaces'; spaces: ReadonlyArray<TabOrderEntry> }
  /** Show a Space: from the drawer, from the strip, or straight after creating one. */
  | { type: 'open'; spaceId: string }
  /** Close one tab. */
  | { type: 'close'; spaceId: string }
  /** Drop a tab in front of another, or at the end when `beforeSpaceId` is null. */
  | { type: 'reorder'; spaceId: string; beforeSpaceId: string | null }
  /** Leave this project for another one. */
  | { type: 'reset' };

/** Where every project page starts. */
export const INITIAL_TAB_STATE: TabState = {
  ready: false,
  openIds: [],
  activeId: null,
};

/**
 * Which tab is showing, once the strip has settled on `openIds`.
 *
 * The one place I1 and I2 are enforced: the active tab is null exactly when
 * the strip is empty, and otherwise names a tab on it. A choice that is still
 * on the strip stands; anything else falls to the leftmost tab.
 * @param openIds - The strip as it now stands.
 * @param chosen - The tab that was showing, if any.
 * @returns The tab to show.
 */
function settleActive(
  openIds: ReadonlyArray<string>,
  chosen: string | null,
): string | null {
  if (chosen !== null && openIds.includes(chosen)) return chosen;
  return openIds[0] ?? null;
}

/**
 * Fold the live Spaces in.
 *
 * The subscription hands over the whole map every time — `observeDeep` gives
 * no delta — so one call can carry several Spaces arriving and several leaving
 * at once. Filtering the whole list against it settles the batch in one step
 * and answers both: Spaces that left drop out, Spaces that arrived are not
 * opened, because a Space somebody else created is not a tab of mine.
 *
 * A strip emptied this way stays empty. The tab bar being empty for a moment
 * costs a click on the drawer; refilling it would be the one piece of new
 * machinery in a change that is otherwise all deletion.
 * @param state - The state as it stands.
 * @param spaces - Every Space the project has right now.
 * @returns The settled state, or `state` itself when nothing left.
 */
function foldSpaces(
  state: TabState,
  spaces: ReadonlyArray<TabOrderEntry>,
): TabState {
  if (!state.ready) {
    const openIds = initialOpenTabIds(spaces);
    return { ready: true, openIds, activeId: settleActive(openIds, null) };
  }
  const live = new Set(spaces.map((s) => s.id));
  const openIds = state.openIds.filter((id) => live.has(id));
  if (openIds.length === state.openIds.length) return state;
  return { ...state, openIds, activeId: settleActive(openIds, state.activeId) };
}

/**
 * The one place the tab strip and the active tab change.
 * @param state - The state as it stands.
 * @param action - What happened.
 * @returns The next state, or `state` itself when the action changes nothing.
 */
export function reduceTabState(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case 'spaces':
      return foldSpaces(state, action.spaces);
    case 'open': {
      if (state.activeId === action.spaceId) return state;
      if (state.openIds.includes(action.spaceId)) {
        return { ...state, activeId: action.spaceId };
      }
      return {
        ...state,
        openIds: [...state.openIds, action.spaceId],
        activeId: action.spaceId,
      };
    }
    case 'close': {
      const openIds = state.openIds.filter((id) => id !== action.spaceId);
      return {
        ...state,
        openIds,
        activeId: settleActive(openIds, state.activeId),
      };
    }
    case 'reorder': {
      const openIds = applyTabMove(
        state.openIds,
        action.spaceId,
        action.beforeSpaceId,
      );
      return sameTabOrder(openIds, state.openIds)
        ? state
        : { ...state, openIds };
    }
    case 'reset':
      return INITIAL_TAB_STATE;
  }
}
