// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

interface BrandMarkProps {
  /** Rendered width/height in px (the mark is square). Defaults to 28. */
  size?: number;
}

/**
 * Maps the outlines onto the viewBox: one uniform scale with a y-flip, which
 * keeps the source aspect ratio and turns the tracer's y-up coordinates into
 * the viewBox's y-down ones. All three paths share it, so the shapes stay
 * registered to each other.
 */
const TRANSFORM = 'translate(-46.512353,137.124128) scale(0.01476023,-0.01476023)';

/**
 * Brand mark — the Breatic logo as an inlined SVG, with no link or wordmark so
 * each chrome (project top bar, studio top bar) wraps it in its own home link.
 * A B in three parts: a rust bowl (#BC4B36) at the bottom, a sky stem
 * (#0EA5E9) rising on the left, and a lime chamber (#15D45A) at the top right.
 * The bowl reaches a few units under the stem along their cut, and the stem
 * is drawn after it, so the two colours meet without an anti-aliased seam.
 *
 * Single source of the mark, shared by both top bars so neither duplicates
 * the SVG. Lives in `ui/` (the cross-feature atom layer) because both
 * `pages/project` and `pages/studio` consume it — a `pages → pages` import
 * would couple the two pages.
 *
 * The logo is the only place the brand raw colors are allowed (ADR 14
 * amended + brand-guard CI); chrome elsewhere uses neutral / primary.
 * Geometry: viewBox `0 0 100 100`, the three outlines of `logo-master.svg` in
 * the operations repo's `strategy/logo/b-tricolor/`, whose SPEC.md holds the
 * full spec. Every element sets fill explicitly (raster backend
 * compatibility). It is scaled by `size` alone (the viewBox is fixed), so it
 * stays crisp at any px.
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
        id='bowl'
        fill='#BC4B36'
        transform={TRANSFORM}
        d='M4103.50 5164.27 L4105.00 3375.00 L4128.00 3296.00 C4193.00 3065.00 4338.00 2897.00 4545.00 2810.00 C4690.00 2750.00 4697.00 2750.00 5965.00 2750.00 C6691.00 2750.00 7157.00 2754.00 7230.00 2761.00 C7913.00 2823.00 8505.00 3234.00 8799.00 3850.00 C9132.00 4547.00 8987.00 5387.00 8436.00 5958.00 C8278.00 6122.00 8132.00 6229.00 7925.00 6333.00 C7548.00 6522.00 7119.00 6575.00 6739.00 6479.00 C6549.00 6431.00 6514.00 6415.00 5880.00 6078.00 C5657.00 5959.00 5282.00 5760.00 5045.00 5635.00 C4809.00 5510.00 4604.00 5400.00 4591.00 5392.00 C4569.00 5377.00 4568.00 5377.00 4573.00 5395.00 L4573.00 5403.00 Z'
      />
      <path
        id='stem'
        fill='#0EA5E9'
        transform={TRANSFORM}
        d='M4573.00 5395.00 C4576.00 5406.00 4585.00 5438.00 4591.00 5465.00 C4628.00 5616.00 4693.00 5712.00 4941.00 5980.00 C5240.00 6305.00 5360.00 6485.00 5438.00 6727.00 C5496.00 6904.00 5495.00 6892.00 5495.00 7705.00 L5495.00 8455.00 L5471.00 8525.00 C5429.00 8650.00 5381.00 8729.00 5295.00 8816.00 C5162.00 8950.00 5028.00 9009.00 4840.00 9015.00 C4782.00 9017.00 4712.00 9015.00 4684.00 9010.00 C4611.00 8997.00 4510.00 8958.00 4443.00 8919.00 C4370.00 8875.00 4255.00 8760.00 4211.00 8687.00 C4164.00 8607.00 4122.00 8476.00 4110.00 8367.00 C4102.00 8304.00 4100.00 7500.00 4102.00 5825.00 L4103.50 5156.27 Z'
      />
      <path
        id='top'
        fill='#15D45A'
        transform={TRANSFORM}
        d='M5770.00 9050.00 C5718.00 9047.00 5645.00 9038.00 5607.00 9031.00 L5540.00 9018.00 L5560.00 8991.00 C5625.00 8909.00 5702.00 8780.00 5728.00 8713.00 C5784.00 8568.00 5792.00 8505.00 5800.00 8140.00 C5808.00 7815.00 5811.00 7775.00 5847.00 7665.00 C5973.00 7266.00 6320.00 6956.00 6775.00 6834.00 C6909.00 6799.00 7167.00 6789.00 7303.00 6814.00 C7726.00 6894.00 8065.00 7201.00 8185.00 7614.00 C8353.00 8197.00 8000.00 8829.00 7412.00 8995.00 C7210.00 9052.00 7207.00 9053.00 6510.00 9055.00 C6155.00 9056.00 5822.00 9054.00 5770.00 9050.00 Z'
      />
    </svg>
  );
}
