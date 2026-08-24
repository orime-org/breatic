// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
