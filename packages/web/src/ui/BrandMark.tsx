// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

interface BrandMarkProps {
  /** Rendered width/height in px (the mark is square). Defaults to 28. */
  size?: number;
}

/**
 * Brand mark — the three-tadpole Breatic logo as an inlined SVG, with no
 * link or wordmark so each chrome (project top bar, studio top bar) wraps it
 * in its own home link. Three tadpoles loop clockwise: main brand (rust red
 * #BC4B36) bottom-right, companion sky (#0EA5E9) left, companion lime
 * (#15D45A) top-right.
 *
 * Single source of the mark, shared by both top bars so neither duplicates
 * the SVG. Lives in `ui/` (the cross-feature atom layer) because both
 * `pages/project` and `pages/studio` consume it — a `pages → pages` import
 * would couple the two pages.
 *
 * The logo is the only place the brand raw colors are allowed (ADR 14
 * amended + brand-guard CI); chrome elsewhere uses neutral / primary.
 * Geometry: viewBox `-50 -50 100 100`, `g scale(1,-1)` y-flip; each element
 * sets fill/stroke explicitly (raster backend compatibility). It is scaled by
 * `size` alone (the viewBox is fixed), so it stays crisp at any px.
 * @param props - Brand-mark props.
 * @param props.size - Rendered px size (square); defaults to 28.
 * @returns the inlined three-tadpole brand SVG mark.
 */
export function BrandMark({ size = 28 }: BrandMarkProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox='-50 -50 100 100'
      aria-hidden='true'
      focusable='false'
      data-testid='top-bar-logo'
    >
      <g transform='scale(1, -1)'>
        <circle cx='25.98' cy='-15' r='10' fill='#BC4B36' />
        <path
          d='M 25.98 -15 A 30 30 0 0 0 -25.98 -15'
          fill='none'
          stroke='#BC4B36'
          strokeWidth='8'
          strokeLinecap='round'
        />
        <circle cx='-30' cy='0' r='7' fill='#0EA5E9' />
        <path
          d='M -30 0 A 30 30 0 0 0 -7.76 28.98'
          fill='none'
          stroke='#0EA5E9'
          strokeWidth='6'
          strokeLinecap='round'
        />
        <circle cx='7.76' cy='28.98' r='7' fill='#15D45A' />
        <path
          d='M 7.76 28.98 A 30 30 0 0 0 30 0'
          fill='none'
          stroke='#15D45A'
          strokeWidth='6'
          strokeLinecap='round'
        />
      </g>
    </svg>
  );
}
