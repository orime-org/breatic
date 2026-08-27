// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { regionOf } from '@web/lib/keyboard-scope';
import { useUIStore } from '@web/stores/ui';

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
      const store = useUIStore.getState();
      // Highlighted words say "these are the ones you are working with", and
      // the space taking over makes that untrue: the keys are the canvas's
      // from here on. Dropping the highlight leaves one answer on the screen
      // rather than two that contradict each other.
      if (region === 'space' && store.activeRegion !== 'space') {
        window.getSelection()?.removeAllRanges();
      }
      store.setActiveRegion(region);
    };
    document.addEventListener('pointerdown', claim, true);
    document.addEventListener('focusin', claim, true);
    return () => {
      document.removeEventListener('pointerdown', claim, true);
      document.removeEventListener('focusin', claim, true);
    };
  }, []);
}
