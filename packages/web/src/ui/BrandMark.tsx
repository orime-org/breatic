// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

interface BrandMarkProps {
  /** Rendered width/height in px (the mark is square). Defaults to 28. */
  size?: number;
}

/**
 * Maps the traced outlines onto the viewBox: the outer pair places the mark at
 * the source aspect ratio, the inner pair is the tracer's own y-flip. All three
 * paths share it, so the shapes stay registered to each other.
 */
const TRANSFORM =
  'translate(0.926888,-0.005946) scale(0.07814190) ' +
  'translate(0.000000,1280.000000) scale(0.100000,-0.100000)';

/**
 * Brand mark — the Breatic logo as an inlined SVG, with no link or wordmark so
 * each chrome (project top bar, studio top bar) wraps it in its own home link.
 * An open sky ring (#0EA5E9) carries a lime particle (#15D45A) at its crown,
 * and a rust core (#BC4B36) sits inside: a vertical anchor, a small upper
 * chamber held apart from it, and a fuller lower one. The white space between
 * them reads as a B on second glance rather than first.
 *
 * Single source of the mark, shared by both top bars so neither duplicates
 * the SVG. Lives in `ui/` (the cross-feature atom layer) because both
 * `pages/project` and `pages/studio` consume it — a `pages → pages` import
 * would couple the two pages.
 *
 * The logo is the only place the brand raw colors are allowed (ADR 14
 * amended + brand-guard CI); chrome elsewhere uses neutral / primary.
 * Geometry: viewBox `0 0 100 100`, three Bezier outlines traced from
 * `marketing/logo/orbit-b-negative-space-curve/reference/approved-effect.png`,
 * whose SPEC.md holds the full spec. Every element sets fill explicitly
 * (raster backend compatibility). It is scaled by `size` alone (the viewBox is
 * fixed), so it stays crisp at any px.
 * @param props - Brand-mark props.
 * @param props.size - Rendered px size (square); defaults to 28.
 * @returns the inlined brand SVG mark.
 */
export function BrandMark({ size = 28 }: BrandMarkProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 100 100'
      aria-hidden='true'
      focusable='false'
      data-testid='top-bar-logo'
    >
      <path
        id='blue'
        fill='#0EA5E9'
        transform={TRANSFORM}
        d='M3973 10975 c-137 -37 -610 -314 -913 -535 -264 -192 -447 -348 -689 -585 -619 -608 -1065 -1290 -1361 -2085 -120 -320 -206 -647 -265 -1005 -61 -372 -69 -478 -69 -900 0 -409 11 -545 70 -899 191 -1135 745 -2206 1564 -3027 554 -555 1196 -965 1955 -1247 432 -161 850 -262 1310 -316 456 -54 1010 -50 1470 10 1192 155 2328 703 3178 1533 626 611 1120 1408 1397 2256 200 613 281 1167 267 1814 -8 373 -37 634 -107 983 -237 1177 -836 2216 -1749 3032 -397 355 -870 681 -1301 897 -142 71 -226 93 -335 86 -117 -7 -201 -44 -281 -122 -140 -137 -176 -317 -104 -509 37 -98 130 -186 287 -270 575 -312 1044 -672 1435 -1105 574 -635 911 -1282 1097 -2107 82 -367 105 -582 106 -999 0 -373 -12 -520 -71 -835 -80 -426 -194 -775 -379 -1158 -109 -224 -163 -320 -301 -527 -423 -639 -975 -1148 -1650 -1523 -846 -470 -1905 -671 -2879 -546 -926 119 -1778 503 -2471 1115 -698 617 -1211 1455 -1433 2344 -105 422 -145 727 -144 1110 2 910 297 1848 821 2610 263 383 552 695 922 994 308 249 501 380 949 640 94 56 145 101 193 175 152 234 69 545 -177 669 -89 45 -241 59 -342 32z'
      />
      <path
        id='green'
        fill='#15D45A'
        transform={TRANSFORM}
        d='M6125 12233 c-205 -28 -414 -135 -569 -290 -305 -305 -381 -780 -188 -1168 121 -245 337 -432 592 -515 102 -33 192 -43 344 -37 170 5 256 26 401 97 614 298 766 1103 302 1596 -163 173 -341 270 -566 309 -77 14 -244 18 -316 8z'
      />
      <path
        id='red'
        fill='#BC4B36'
        transform={TRANSFORM}
        d='M5770 9050 c-52 -3 -125 -12 -163 -19 l-67 -13 20 -27 c65 -82 142 -211 168 -278 56 -145 64 -208 72 -573 8 -325 11 -365 47 -475 126 -399 473 -709 928 -831 134 -35 392 -45 528 -20 423 80 762 387 882 800 168 583 -185 1215 -773 1381 -202 57 -205 58 -902 60 -355 1 -688 -1 -740 -5z M4684 9010 c-73 -13 -174 -52 -241 -91 -73 -44 -188 -159 -232 -232 -47 -80 -89 -211 -101 -320 -8 -63 -10 -867 -8 -2542 l3 -2450 23 -79 c65 -231 210 -399 417 -486 145 -60 152 -60 1420 -60 726 0 1192 4 1265 11 683 62 1275 473 1569 1089 333 697 188 1537 -363 2108 -158 164 -304 271 -511 375 -377 189 -806 242 -1186 146 -190 -48 -225 -64 -859 -401 -223 -119 -598 -318 -835 -443 -236 -125 -441 -235 -454 -243 -22 -15 -23 -15 -18 3 3 11 12 43 18 70 37 151 102 247 350 515 299 325 419 505 497 747 58 177 57 165 57 978 l0 750 -24 70 c-42 125 -90 204 -176 291 -133 134 -267 193 -455 199 -58 2 -128 0 -156 -5z'
      />
    </svg>
  );
}
