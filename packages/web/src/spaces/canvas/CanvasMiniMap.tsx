// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { MiniMap } from '@xyflow/react';
import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { minimapNodeColor } from '@web/spaces/canvas/minimap-node-color';

/**
 * The canvas bird's-eye minimap (#1548) — ReactFlow's MiniMap in the
 * viewport's bottom-right, lifted above the viewport toolbar, painted as a
 * floating overlay (popover surface + hairline + shadow) and colored by the
 * 7-color palette node-type mapping. Pannable + zoomable: dragging inside
 * the map moves the main viewport (read-only for the document — safe for
 * viewers). Mounted by the canvas only while the toolbar's minimap toggle
 * (single source: the canvas store) is on.
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
      // Surface colors ride the token system (auto light/dark); the mask is a
      // translucent canvas-tone wash so the viewport window reads as a hole.
      bgColor='var(--color-popover)'
      maskColor='color-mix(in srgb, var(--color-canvas) 65%, transparent)'
      maskStrokeColor='var(--color-active-border)'
      // The className lands on the outer Panel div (source-verified): lift it
      // above the viewport toolbar (anchored bottom-4 = 16px, 42px tall incl.
      // border → its top edge sits at 58px) and paint the floating-overlay
      // surface. mb-16 = 64px leaves a 6px gap; mr-4 matches the toolbar's
      // own inset. Radius is the 6px chrome step — deliberately distinct
      // from the 12px toolbar (user decision 2026-07-03); the inner node
      // rects / viewport mask keep the library defaults.
      className='!m-0 !mr-4 !mb-16 rounded-chrome border border-border shadow'
    />
  );
}
