// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectSpace } from '@web/data/yjs/project-meta';

/**
 * Resolves which Space the page should show as active. The active tab is
 * LOCAL-ONLY state (user 2026-07-11): it used to live in the shared per-user
 * Yjs subtree, which two machines on the same account both live-subscribe
 * to — machine A clicking a tab flipped machine B's active tab and remounted
 * B's running space body. Opening a project therefore starts with no local
 * choice and shows the FIRST open tab; a local choice wins while its tab is
 * still open; a stale choice (tab closed on another machine / space deleted)
 * falls back to the first open tab.
 * @param openTabs - The user's open tabs, resolved against the live spaces.
 * @param localActiveId - This window's own active-tab choice (null = none yet).
 * @returns The Space to render, or undefined when no tabs are open.
 */
export function resolveEffectiveActiveSpace(
  openTabs: ReadonlyArray<ProjectSpace>,
  localActiveId: string | null,
): ProjectSpace | undefined {
  return openTabs.find((s) => s.id === localActiveId) ?? openTabs[0];
}

/** What the page knows about its own tab choice right now. */
export interface TabChoiceState {
  /** The tabs on the strip, in the order they are painted. */
  openTabIds: ReadonlyArray<string>;
  /** This window's own choice, null before one has been made. */
  activeSpaceId: string | null;
  /** What the page is showing, undefined when the strip is empty. */
  shownId: string | undefined;
  /** The Space a `tab:open` is travelling for, null when none is. */
  openingTab: string | null;
}

/** What has to change for the choice to name something again. */
export interface TabChoiceRevision {
  /** The choice to write, absent when it stands. */
  activeSpaceId?: string;
  /** Present once the travelling `tab:open` has arrived. */
  clearOpening?: boolean;
}

/**
 * Says what the page has to change for its tab choice to name a real tab.
 *
 * The invariant: the choice either names a tab on the strip, or names one a
 * `tab:open` is still travelling for. Anything else leaves the page falling
 * back by POSITION, and a reorder then swaps the body out from under the
 * user — including remotely, from another connection on the same account,
 * which is the thing that moving the active tab out of the shared doc set out
 * to stop.
 *
 * Which of the two a missing tab is cannot be read off the strip: a choice
 * whose tab has not arrived yet and one whose tab has left look the same
 * there. The travelling Space is what tells them apart.
 * @param state - What the page knows right now.
 * @returns The changes to apply, empty when the choice already holds.
 */
export function reviseTabChoice(state: TabChoiceState): TabChoiceRevision {
  const { openTabIds, activeSpaceId, shownId, openingTab } = state;
  if (activeSpaceId === null) {
    return openTabIds.length > 0 ? { activeSpaceId: openTabIds[0]! } : {};
  }
  if (openTabIds.includes(activeSpaceId)) {
    return openingTab === activeSpaceId ? { clearOpening: true } : {};
  }
  if (openingTab === activeSpaceId) return {};
  return shownId === undefined ? {} : { activeSpaceId: shownId };
}
