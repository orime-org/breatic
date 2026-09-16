// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  applyTabMove,
  initialOpenTabIds,
  sameTabOrder,
  type TabOrderEntry,
} from '@breatic/shared';

import type { RestoredTabs } from '@web/lib/project-tabs-storage';

/**
 * The tab bar, as this one browser tab holds it.
 *
 * The browser remembers it per account and project, so a reload comes back to
 * the tabs that were open and the one that was showing (user 2026-09-16). What
 * was remembered arrives here as `restored` and is spent on the first batch of
 * Spaces; from then on this reducer is the only thing that moves the strip.
 */
export interface TabState {
  /** False until the meta document has synced, when `spaces` cannot be read yet. */
  ready: boolean;
  /** The tabs on the strip, in the order they are painted. */
  openIds: ReadonlyArray<string>;
  /** The tab whose Space the page is showing, null only when the strip is empty. */
  activeId: string | null;
  /**
   * The project this strip belongs to.
   *
   * The page is not remounted when the route moves from one project to
   * another, so without this the read that happens once at mount and the write
   * that follows every change could name different projects — and the write
   * would land on the project being arrived at, carrying the tabs of the one
   * being left.
   */
  projectId: string;
  /**
   * What the browser was holding for this project when the page opened, spent
   * by the first `spaces` action and null from then on.
   *
   * Null and an empty list are different answers: null is "this account has
   * never left a strip here", which opens the newest Space, while an empty
   * list is "this account closed every tab", which stays empty.
   */
  restored: RestoredTabs | null;
}

/** Everything that can move the tab bar. */
export type TabAction =
  /** The live Spaces, as a whole. The first arrival settles the strip; later ones drop tabs whose Space is gone. */
  | { type: 'spaces'; spaces: ReadonlyArray<TabOrderEntry> }
  /** Show a Space: from the drawer, from the strip, or straight after creating one. */
  | { type: 'open'; spaceId: string }
  /** Close one tab. */
  | { type: 'close'; spaceId: string }
  /** Drop a tab in front of another, or at the end when `beforeSpaceId` is null. */
  | { type: 'reorder'; spaceId: string; beforeSpaceId: string | null }
  /** The route moved to another project, with whatever that one had stored. */
  | { type: 'project'; projectId: string; restored: RestoredTabs | null };

/**
 * Where a project page starts.
 * @param projectId - The project being opened.
 * @param restored - What the browser had stored for it, or null.
 * @returns The state to hand `useReducer`.
 */
export function initialTabState(
  projectId: string,
  restored: RestoredTabs | null,
): TabState {
  return { ready: false, openIds: [], activeId: null, projectId, restored };
}

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
 * The strip this page opens on, out of what the browser was holding.
 *
 * A Space that has been deleted since is dropped, and a Space the stored list
 * names twice becomes one tab: the `open` action keeps `openIds` free of
 * repeats for everything that happens in a session, and this is the other way
 * in — a hand-edited record would otherwise put two tabs on the strip that
 * share a React key and attach one document twice.
 * @param restored - What the browser was holding, or null when it held nothing.
 * @param spaces - Every Space the project has right now.
 * @returns The tabs to open, in the order they are painted.
 */
function restoredOpenIds(
  restored: RestoredTabs | null,
  spaces: ReadonlyArray<TabOrderEntry>,
): string[] {
  if (restored === null) return initialOpenTabIds(spaces);
  const live = new Set(spaces.map((s) => s.id));
  const kept = [...new Set(restored.openIds)].filter((id) => live.has(id));
  // Every Space the record named is gone, so this is a strip that cannot be
  // restored rather than one the account chose to empty.
  return kept.length === 0 && restored.openIds.length > 0
    ? initialOpenTabIds(spaces)
    : kept;
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
 * A strip emptied this way stays empty, and so does one the account emptied
 * before it left: the tab bar being empty costs a click on the drawer, while
 * refilling it would take back a choice the user made.
 * @param state - The state as it stands.
 * @param spaces - Every Space the project has right now.
 * @returns The settled state, or `state` itself when nothing left.
 */
function foldSpaces(
  state: TabState,
  spaces: ReadonlyArray<TabOrderEntry>,
): TabState {
  if (!state.ready) {
    const openIds = restoredOpenIds(state.restored, spaces);
    return {
      ...state,
      ready: true,
      openIds,
      activeId: settleActive(openIds, state.restored?.activeId ?? null),
      restored: null,
    };
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
    case 'project':
      return initialTabState(action.projectId, action.restored);
  }
}
