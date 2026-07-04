// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useUIStore } from '@web/stores';

/**
 * Hook that gives a Sheet / Dialog component an open-state tied to
 * the global `useUIStore.activeOverlayId`. Only one overlay can be
 * open at a time across the app - opening a new one automatically
 * closes any previously open peer (its `[open]` flips to `false`
 * because `activeOverlayId !== id` for it).
 *
 * Design source: 2026-05-25 user decision "Sheet/Dialog default to non-modal
 * + globally exclusive - only one overlay open at a time, opening a new one
 * closes the old". See also the
 * primitive change in `components/ui/sheet.tsx` + `dialog.tsx` that
 * makes `modal={false}` + `withOverlay` the default.
 *
 * Usage:
 *
 *   const [open, setOpen] = useExclusiveOverlay('space-drawer');
 *   return <Sheet open={open} onOpenChange={setOpen}>...</Sheet>;
 *
 * `id` must be unique per overlay surface across the whole app. A
 * stable string literal is fine - these are not user-facing keys.
 * @param id - Stable string id for this overlay surface
 * @returns `[open, setOpen]` mimicking `React.useState<boolean>`'s API
 */
export function useExclusiveOverlay(
  id: string,
): [boolean, (next: boolean) => void] {
  const activeId = useUIStore((s) => s.activeOverlayId);
  const setActiveId = useUIStore((s) => s.setActiveOverlayId);

  const open = activeId === id;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) {
        // Claim the slot - any previously open overlay sees its `open`
        // flip to false on the next render and unmounts itself.
        setActiveId(id);
      } else if (useUIStore.getState().activeOverlayId === id) {
        // Only release the slot if we're currently the active one.
        // Avoids a stale-close race when another overlay has already
        // taken over. MUST read the store's live value, not the render
        // closure: a handler that claims for overlay B and then
        // releases overlay A runs before any re-render, so A's closure
        // still says A owns the slot and would null out B's claim
        // (SpaceDrawer "view" -> read-only sheet handoff, 2026-07-04).
        setActiveId(null);
      }
    },
    [id, setActiveId],
  );

  return [open, setOpen];
}
