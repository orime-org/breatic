// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

interface BrandMarkProps {
  /** Rendered width/height in px (the mark is square). Defaults to 28. */
  size?: number;
}

/**
 * Brand mark — the Breatic logo as an inlined SVG, with no link or wordmark so
 * each chrome (project top bar, studio top bar) wraps it in its own home link.
 * A rust ring (#BC4B36) holds two flattened ellipses stacked vertically: lime
 * (#15D45A) above, sky (#0EA5E9) below. The two ellipses imply the bowls of a
 * B without drawing one — spelling the letter would put the mark in the pool
 * of class-9 letter marks it needs to stay clear of.
 *
 * Single source of the mark, shared by both top bars so neither duplicates
 * the SVG. Lives in `ui/` (the cross-feature atom layer) because both
 * `pages/project` and `pages/studio` consume it — a `pages → pages` import
 * would couple the two pages.
 *
 * The logo is the only place the brand raw colors are allowed (ADR 14
 * amended + brand-guard CI); chrome elsewhere uses neutral / primary.
 * Geometry: viewBox `-50 -50 100 100`, ring `r=38` with a 5.5 stroke, each
 * ellipse `rx=18 ry=9` offset 11.5 either side of centre. Every element sets
 * fill/stroke explicitly (raster backend compatibility). It is scaled by
 * `size` alone (the viewBox is fixed), so it stays crisp at any px.
 * @param props - Brand-mark props.
 * @param props.size - Rendered px size (square); defaults to 28.
 * @returns the inlined brand SVG mark.
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
      <circle
        cx='0'
        cy='0'
        r='38'
        fill='none'
        stroke='#BC4B36'
        strokeWidth='5.5'
      />
      <ellipse cx='0' cy='-11.5' rx='18' ry='9' fill='#15D45A' />
      <ellipse cx='0' cy='11.5' rx='18' ry='9' fill='#0EA5E9' />
    </svg>
  );
}
