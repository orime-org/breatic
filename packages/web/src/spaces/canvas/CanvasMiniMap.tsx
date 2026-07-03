// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { MiniMap } from '@xyflow/react';
import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { minimapNodeColor } from '@web/spaces/canvas/minimap-node-color';

/**
 * The canvas bird's-eye minimap (#1548) — ReactFlow's MiniMap in the
 * viewport's bottom-right, spaced and rounded as the zoom popover's twin
 * (66px = the toolbar's 58px top edge + the popover's sideOffset-8 gap;
 * `rounded-overlay`), painted as a floating overlay and colored by the
 * 7-color palette node-type mapping. Pannable + zoomable: dragging inside
 * the map moves the main viewport (read-only for the document — safe for
 * viewers). Mounted by the canvas only while the toolbar's minimap toggle
 * (single source: the canvas store) is on.
 *
 * Screen-constant geometry (user report 2026-07-03): the viewport-mask
 * stroke engages the library's viewScale conversion by passing an explicit
 * `maskStrokeWidth`. Node rects are square-cornered (user-ratified: any
 * fixed screen radius balloons proportionally on tiny rects at low zoom —
 * a 2px radius on a 4px-tall rect is a full capsule; Figma's minimap is
 * square-cornered too).
 * @returns The minimap panel element.
 */
export function CanvasMiniMap(): React.JSX.Element {
  const t = useTranslation();
  return (
    <MiniMap
      position='bottom-right'
      pannable
      zoomable
      ariaLabel={t('canvas.minimap.label')}
      nodeColor={minimapNodeColor}
      nodeStrokeColor='transparent'
      nodeBorderRadius={0}
      // Surface colors ride the token system (auto light/dark); the mask is a
      // translucent canvas-tone wash so the viewport window reads as a hole.
      bgColor='var(--color-popover)'
      maskColor='color-mix(in srgb, var(--color-canvas) 65%, transparent)'
      // NO viewport stroke (user 2026-07-03): the mask contrast alone marks
      // the viewport window. Explicit transparent rather than an absent prop
      // so a library-default change can never resurrect a stroke.
      maskStrokeColor='transparent'
      // The className lands on the outer Panel div (source-verified). The
      // 61px bottom margin puts the map's bottom edge exactly where the zoom
      // popover's sits (Radix anchors sideOffset-8 to the TRIGGER button top
      // at 53px, not the toolbar top — same-frame measurement 2026-07-03).
      // overflow-hidden clips the right-angled inner SVG to the rounded
      // frame (without it the corners read square — the "radius mismatch"
      // the user saw; radius + shadow are byte-identical to the popover's).
      className='!m-0 !mr-4 !mb-[61px] overflow-hidden rounded-overlay border border-border shadow'
    />
  );
}
