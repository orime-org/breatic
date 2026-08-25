// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { PickSession } from '@web/stores/canvas';

/**
 * The three local sources that together say which nodes this client is
 * holding right now. They live in different places (`pickSession` in the
 * canvas store, the other two in `CanvasSpaceInner`) and can disagree for a
 * render, so they are read as one snapshot and reconciled here.
 */
export interface ActiveNodeSources {
  /** Ids of the currently selected nodes. */
  selectedIds: readonly string[];
  /** The in-progress pick session, when the canvas is in pick mode. */
  pickSession: PickSession | null;
  /** The node a focus pick has landed on, before its crop is confirmed. */
  focusTargetId: string | null;
}

/**
 * Reduce the three sources to the set published as `activeNodeIds`.
 *
 * A pick session outranks the selection: selection is switched off canvas-wide
 * while a pick runs (`elementsSelectable`), so `selectedIds` is whatever was
 * selected when the pick began and no longer describes the present. The focus
 * target counts only under a `focus` pick — under any other purpose it is a
 * leftover its own effect clears one render later.
 * @param sources - One snapshot of the three sources.
 * @returns The occupied node ids, or null when this client holds nothing.
 */
export function deriveActiveNodeIds(sources: ActiveNodeSources): string[] | null {
  const { selectedIds, pickSession, focusTargetId } = sources;
  if (pickSession === null) {
    return selectedIds.length === 0 ? null : [...selectedIds];
  }
  const target =
    pickSession.purpose === 'focus' && focusTargetId !== null && focusTargetId !== pickSession.nodeId
      ? focusTargetId
      : null;
  return target === null ? [pickSession.nodeId] : [pickSession.nodeId, target];
}

/**
 * Compare a freshly derived set against the one that actually reached the
 * awareness state, so an unchanged holding is not republished every render.
 *
 * The comparison is by VALUE because the value it is checked against is read
 * back out of awareness rather than kept in a local variable: anything that
 * wipes the state from the outside (the bfcache teardown, a provider reset)
 * then shows up as a difference instead of being judged unchanged.
 * @param a - The previously published value.
 * @param b - The freshly derived value.
 * @returns True when the two describe the same holding.
 */
export function sameIdList(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
