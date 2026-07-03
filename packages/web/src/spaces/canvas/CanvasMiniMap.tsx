// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { getNodesBounds, MiniMap, useStore } from '@xyflow/react';
import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { minimapNodeColor } from '@web/spaces/canvas/minimap-node-color';
import { minimapViewScale } from '@web/spaces/canvas/minimap-view-scale';

/**
 * Screen-constant corner radius for the minimap node rects (user-ratified
 * 2026-07-03; the library's default rx=5 is in SVG units and drifted with
 * canvas zoom). Converted to SVG units per render via the view scale.
 */
const NODE_RADIUS_PX = 2;

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
 * `maskStrokeWidth`; the node-rect radius has no such library hook, so the
 * same view scale is mirrored here (`minimapViewScale`) and baked into
 * `nodeBorderRadius` per render.
 * @returns The minimap panel element.
 */
export function CanvasMiniMap(): React.JSX.Element {
  const t = useTranslation();
  // Flow-units-per-minimap-pixel — recomputed as the store changes so the
  // node-rect radius stays a constant NODE_RADIUS_PX on screen.
  const viewScale = useStore((s) =>
    minimapViewScale({
      tx: s.transform[0],
      ty: s.transform[1],
      zoom: s.transform[2],
      flowWidth: s.width,
      flowHeight: s.height,
      nodesBounds: s.nodeLookup.size > 0 ? getNodesBounds(s.nodes) : null,
    }),
  );
  return (
    <MiniMap
      position='bottom-right'
      pannable
      zoomable
      ariaLabel={t('canvas.minimap.label')}
      nodeColor={minimapNodeColor}
      nodeStrokeColor='transparent'
      nodeBorderRadius={NODE_RADIUS_PX * viewScale}
      // Explicit number engages the library's screen-constant conversion —
      // without it the stroke falls back to a static SVG-unit width and
      // visibly drifts with canvas zoom (user report).
      maskStrokeWidth={1}
      // Surface colors ride the token system (auto light/dark); the mask is a
      // translucent canvas-tone wash so the viewport window reads as a hole.
      bgColor='var(--color-popover)'
      maskColor='color-mix(in srgb, var(--color-canvas) 65%, transparent)'
      // Hairline token (12% translucent neutral, the same line every card /
      // the map frame itself uses): the screen-constant 1px width made the
      // old mid-gray active-border read too strong (user 2026-07-03).
      maskStrokeColor='var(--color-border)'
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
