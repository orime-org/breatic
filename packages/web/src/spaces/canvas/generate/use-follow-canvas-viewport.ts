// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Keeps an open canvas popover glued to its trigger while the ReactFlow
 * viewport pans / zooms.
 *
 * Radix positions popovers via Floating UI, whose auto-update reacts to scroll
 * and resize but NOT to ancestor CSS-transform changes. The ReactFlow canvas
 * pans / zooms by mutating the `transform` style on `.react-flow__viewport`, so
 * a portaled popover stays pinned to the viewport while its trigger slides away
 * underneath — the popover drifts off the node. The generate panel itself does
 * not drift because it rides a ReactFlow `NodeToolbar` (screen-space, follows
 * the node); this hook gives the pickers the same behaviour.
 *
 * It observes the viewport element's `style` mutations and, coalesced to one
 * per animation frame, dispatches a `resize` so Floating UI recomputes the
 * popover position from the trigger's live rect — the popover follows the node
 * at a fixed screen size. Inert while closed. The dispatch only nudges open
 * Radix floats to reposition (this mode has no heavy window-resize listeners),
 * and it no-ops outside a canvas (e.g. in unit tests the element is absent).
 * @param open - Whether the popover is open (the follow is inert when closed).
 */
export function useFollowCanvasViewport(open: boolean): void {
  React.useEffect(() => {
    if (!open) return;
    const viewport = document.querySelector('.react-flow__viewport');
    if (!viewport) return;
    let raf = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    });
    observer.observe(viewport, {
      attributes: true,
      attributeFilter: ['style', 'transform'],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [open]);
}
