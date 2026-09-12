// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BrandMark } from '@web/ui/BrandMark';

/** What each path contributes, and enough of its data to catch a swap. */
const PATHS = [
  { id: 'blue', fill: '#0EA5E9', length: 1038, head: 'M3973 10975 c-137 -37 -610 -314' },
  { id: 'green', fill: '#15D45A', length: 219, head: 'M6125 12233 c-205 -28 -414 -135' },
  { id: 'red', fill: '#BC4B36', length: 874, head: 'M5770 9050 c-52 -3 -125 -12 -163' },
] as const;

/** Shared by all three paths: the alignment transform onto the viewBox. */
const TRANSFORM =
  'translate(0.926888,-0.005946) scale(0.07814190) translate(0.000000,1280.000000) scale(0.100000,-0.100000)';

describe('BrandMark', () => {
  it('renders the inlined brand SVG mark, hidden from the a11y tree', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('top-bar-logo');
    expect(mark.tagName.toLowerCase()).toBe('svg');
    // aria-hidden so the mark never pollutes the wrapping link's accessible
    // name (the link supplies its own label).
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the orbit-B geometry: an open ring, a particle, and the core', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('top-bar-logo');
    // The mark is the registrable identity, so its geometry is pinned here:
    // a drift in any of this is a different logo, not a restyle. Path data is
    // checked by length and opening segment — enough to catch a swapped or
    // truncated path while leaving this file readable.
    expect(mark).toHaveAttribute('viewBox', '0 0 100 100');

    const paths = [...mark.querySelectorAll('path')];
    expect(paths).toHaveLength(PATHS.length);

    for (const [i, expected] of PATHS.entries()) {
      const path = paths[i];
      expect(path).toHaveAttribute('id', expected.id);
      expect(path).toHaveAttribute('fill', expected.fill);
      expect(path).toHaveAttribute('transform', TRANSFORM);

      const d = path?.getAttribute('d') ?? '';
      expect(d).toHaveLength(expected.length);
      expect(d.startsWith(expected.head)).toBe(true);
    }
  });

  it('defaults to 28px and honors an explicit size', () => {
    const { rerender } = render(<BrandMark />);
    const def = screen.getByTestId('top-bar-logo');
    expect(def).toHaveAttribute('width', '28');
    expect(def).toHaveAttribute('height', '28');

    rerender(<BrandMark size={24} />);
    const sized = screen.getByTestId('top-bar-logo');
    expect(sized).toHaveAttribute('width', '24');
    expect(sized).toHaveAttribute('height', '24');
  });
});
