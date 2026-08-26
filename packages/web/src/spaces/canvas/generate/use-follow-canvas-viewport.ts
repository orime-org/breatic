// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { observeViewportTransform } from '@web/spaces/canvas/viewport-observer';

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
 * It watches the viewport for moves and, coalesced to one per animation frame,
 * dispatches a `resize` so Floating UI recomputes the popover position from the
 * trigger's live rect — the popover follows the node at a fixed screen size.
 * Inert while closed. The dispatch nudges open Radix floats to reposition;
 * xyflow's own window-resize handler also fires but is idempotent when the
 * container size is unchanged. It no-ops outside a canvas (e.g. in unit tests
 * the element is absent).
 * @param open - Whether the popover is open (the follow is inert when closed).
 */
export function useFollowCanvasViewport(open: boolean): void {
  React.useEffect(() => {
    if (!open) return undefined;
    let raf = 0;
    const stop = observeViewportTransform(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    });
    return (): void => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, [open]);
}
