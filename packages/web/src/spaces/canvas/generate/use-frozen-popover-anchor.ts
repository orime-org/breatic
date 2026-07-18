// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/** A minimal measurable for Radix's PopoverAnchor `virtualRef`. */
interface FrozenMeasurable {
  getBoundingClientRect: () => DOMRect;
}

interface FrozenPopoverAnchor {
  /** Popover open state (owned here so the snapshot fires on the open edge). */
  open: boolean;
  /** Pass to `<Popover onOpenChange>`: snapshots the trigger rect when opening. */
  onOpenChange: (open: boolean) => void;
  /** Pass to `<PopoverAnchor virtualRef>`: returns the frozen open-time rect. */
  anchorRef: React.RefObject<FrozenMeasurable>;
}

/**
 * Freezes a canvas popover at its open-time screen position (user 2026-07-18).
 *
 * Radix positions popovers via Floating UI, whose auto-update re-tracks the
 * trigger whenever it moves — so a picker inside the generate panel (a ReactFlow
 * `NodeToolbar`) slides with the node as the canvas pans / zooms. The user wants
 * the opposite: once open, the popover stays put on screen and clips at the
 * viewport edge like the generate panel, rather than following or jumping to
 * avoid collisions. Anchoring to a VIRTUAL element whose rect is snapshotted at
 * open time (and never updated) makes every reposition resolve to the same
 * coordinates, so the popover is effectively frozen. Pair with
 * `avoidCollisions={false}` so it clips instead of shifting near an edge.
 *
 * The trigger is found by `data-testid` (no ref threading through `asChild`); the
 * rect is read synchronously on the open edge, before Radix renders the content.
 * @param triggerTestId - The trigger button's `data-testid` (rect source).
 * @returns The popover open state, an onOpenChange that snapshots, and the anchor ref.
 */
export function useFrozenPopoverAnchor(
  triggerTestId: string,
): FrozenPopoverAnchor {
  const [open, setOpen] = React.useState(false);
  const rectRef = React.useRef<DOMRect | null>(null);
  const anchorRef = React.useRef<FrozenMeasurable>({
    getBoundingClientRect: () => rectRef.current ?? new DOMRect(),
  });
  const onOpenChange = React.useCallback(
    (next: boolean): void => {
      if (next) {
        const el = document.querySelector(`[data-testid="${triggerTestId}"]`);
        if (el) rectRef.current = el.getBoundingClientRect();
      }
      setOpen(next);
    },
    [triggerTestId],
  );
  return { open, onOpenChange, anchorRef };
}
