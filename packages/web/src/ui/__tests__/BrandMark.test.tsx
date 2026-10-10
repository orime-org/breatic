// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BrandMark } from '@web/ui/BrandMark';

/** What each path contributes, and enough of its data to catch a swap. */
const PATHS = [
  { id: 'bowl', fill: '#BC4B36', length: 608, head: 'M4103.50 5164.27 L4105.00 3375' },
  { id: 'stem', fill: '#0EA5E9', length: 608, head: 'M4573.00 5395.00 C4576.00 5406' },
  { id: 'top', fill: '#15D45A', length: 542, head: 'M5770.00 9050.00 C5718.00 9047' },
] as const;

/** Shared by all three paths: the alignment transform onto the viewBox. */
const TRANSFORM = 'translate(-46.512353,137.124128) scale(0.01476023,-0.01476023)';

describe('BrandMark', () => {
  it('renders the inlined brand SVG mark, hidden from the a11y tree', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('top-bar-logo');
    expect(mark.tagName.toLowerCase()).toBe('svg');
    // aria-hidden so the mark never pollutes the wrapping link's accessible
    // name (the link supplies its own label).
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the B Tricolor geometry: the bowl, the stem, and the top chamber', () => {
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
