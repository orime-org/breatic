import type * as React from 'react';
import { Link } from 'react-router-dom';

/**
 * 28×28 Logo — three-tadpole brand mark, inlined SVG.
 *
 * Three tadpoles in a clockwise loop:
 *   - main brand (rust red #BC4B36) at the bottom-right
 *   - companion sky (#0EA5E9) on the left
 *   - companion lime (#15D45A) on the top-right
 *
 * Logo is the only place the brand raw colors are allowed (per ADR 14
 * amended + brand-guard CI). Chrome elsewhere uses neutral / primary.
 *
 * Geometry: viewBox `-50 -50 100 100`, `g scale(1,-1)` y-flip. Each
 * element sets fill/stroke explicitly (raster backend compatibility).
 * @returns the brand logo as a home link wrapping the inlined SVG mark.
 */
export function Logo28(): React.JSX.Element {
  return (
    <Link to='/studio' aria-label='Home' className='inline-flex items-center'>
      <svg
        width='28'
        height='28'
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
    </Link>
  );
}
