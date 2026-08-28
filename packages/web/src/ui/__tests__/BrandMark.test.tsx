// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BrandMark } from '@web/ui/BrandMark';

describe('BrandMark', () => {
  it('renders the inlined brand SVG mark, hidden from the a11y tree', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('top-bar-logo');
    expect(mark.tagName.toLowerCase()).toBe('svg');
    // aria-hidden so the mark never pollutes the wrapping link's accessible
    // name (the link supplies its own label).
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the N1b geometry: a rust ring holding a lime and a sky ellipse', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('top-bar-logo');
    // The mark is the registrable identity, so its geometry is pinned here:
    // a drift in any of these numbers is a different logo, not a restyle.
    expect(mark).toHaveAttribute('viewBox', '-50 -50 100 100');

    const ring = mark.querySelector('circle');
    expect(ring).toHaveAttribute('r', '38');
    expect(ring).toHaveAttribute('stroke', '#BC4B36');
    expect(ring).toHaveAttribute('stroke-width', '5.5');
    expect(ring).toHaveAttribute('fill', 'none');

    const ellipses = [...mark.querySelectorAll('ellipse')];
    expect(ellipses).toHaveLength(2);
    for (const el of ellipses) {
      expect(el).toHaveAttribute('cx', '0');
      expect(el).toHaveAttribute('rx', '18');
      expect(el).toHaveAttribute('ry', '9');
    }
    // Upper bowl is lime, lower is sky; SVG y grows downward.
    const [upper, lower] = ellipses;
    expect(upper).toHaveAttribute('cy', '-11.5');
    expect(upper).toHaveAttribute('fill', '#15D45A');
    expect(lower).toHaveAttribute('cy', '11.5');
    expect(lower).toHaveAttribute('fill', '#0EA5E9');
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
