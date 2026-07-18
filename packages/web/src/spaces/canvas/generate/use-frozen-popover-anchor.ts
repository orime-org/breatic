// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

interface FrozenPopoverAnchor {
  /** Popover open state (owned here so the snapshot fires on the open edge). */
  open: boolean;
  /** Pass to `<Popover onOpenChange>`: snapshots the trigger rect when opening. */
  onOpenChange: (open: boolean) => void;
  /**
   * The trigger's viewport rect captured at open time, or null while closed.
   * Render a `position: fixed` element at this rect as a `<PopoverAnchor asChild>`
   * so the popover anchors to a frozen point.
   */
  frozenRect: DOMRect | null;
}

/**
 * Freezes a canvas popover at its open-time screen position (user 2026-07-18).
 *
 * Radix positions popovers via Floating UI, which re-tracks the anchor whenever
 * it moves — so a picker inside the generate panel (a ReactFlow `NodeToolbar`)
 * slides with the node as the canvas pans / zooms. The user wants the opposite:
 * once open, the popover stays put on screen and clips at the viewport edge like
 * the generate panel, rather than following or jumping to avoid collisions.
 *
 * The fix snapshots the trigger's viewport rect on the open edge and anchors the
 * popover to a `position: fixed` element rendered at that rect (a real DOM anchor
 * via `<PopoverAnchor asChild>` — a Radix `virtualRef` is unreliable here: its
 * composed-ref reset can hand Popper a null anchor, positioning the popover at
 * the viewport corner). A fixed element does not move when the canvas transform
 * changes, so every reposition resolves to the same coordinates → frozen. Pair
 * with `avoidCollisions={false}` so it clips instead of shifting near an edge.
 *
 * The trigger is found by `data-testid` (no ref threading through `asChild`).
 * @param triggerTestId - The trigger button's `data-testid` (rect source).
 * @returns The popover open state, an onOpenChange that snapshots, and the frozen rect.
 */
export function useFrozenPopoverAnchor(
  triggerTestId: string,
): FrozenPopoverAnchor {
  const [open, setOpen] = React.useState(false);
  const [frozenRect, setFrozenRect] = React.useState<DOMRect | null>(null);
  const onOpenChange = React.useCallback(
    (next: boolean): void => {
      if (next) {
        const el = document.querySelector(`[data-testid="${triggerTestId}"]`);
        setFrozenRect(el ? el.getBoundingClientRect() : null);
      }
      setOpen(next);
    },
    [triggerTestId],
  );
  return { open, onOpenChange, frozenRect };
}
