// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { regionOf } from '@web/lib/keyboard-scope';
import { useUIStore } from '@web/stores/ui';

/**
 * Drops a live highlight unless it sits inside the space region.
 *
 * Highlighted words say "these are the ones you are working with", and the
 * space being handed the region makes that untrue of a highlight living
 * anywhere else — in the agent panel, in the top bar, in an overlay — so those
 * go and leave one answer on the screen. A highlight inside the space itself
 * is still the reader's current one: extending a document selection with a
 * shift-click needs it as the anchor.
 *
 * The anchor decides, so a drag that started in the agent panel and ended in
 * the space counts as the agent's.
 */
function dropHighlightOutsideSpace(): void {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return;
  const anchor = selection.anchorNode;
  const element =
    anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  if (element !== null && regionOf(element) === 'space') return;
  selection.removeAllRanges();
}

/**
 * Keeps the stored active region on whichever region the user is working in:
 * a pointer press inside a region hands it over, and so does focus entering
 * it — the second one is how Tab reaches a region without a press.
 *
 * Both listeners sit on `document`'s capture phase, which runs before
 * anything inside the app root. Two places in the repo stop propagation
 * before the region roots would see these events: `suppressTooltipFocusOpen`
 * for focusin (through React's delegated listener on the app root) and
 * ScrollArea's `takeOverDrag` for pointerdown on a scrollbar rail.
 */
export function useTrackActiveRegion(): void {
  React.useEffect(() => {
    /**
     * Hands the region the event started in the active slot, if it started in
     * one at all.
     * @param event - A pointerdown or focusin, caught on document's capture
     *   phase.
     */
    const claim = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      const region = regionOf(event.target);
      if (!region) return;
      if (region === 'space') dropHighlightOutsideSpace();
      useUIStore.getState().setActiveRegion(region);
    };
    document.addEventListener('pointerdown', claim, true);
    document.addEventListener('focusin', claim, true);
    return () => {
      document.removeEventListener('pointerdown', claim, true);
      document.removeEventListener('focusin', claim, true);
    };
  }, []);
}
