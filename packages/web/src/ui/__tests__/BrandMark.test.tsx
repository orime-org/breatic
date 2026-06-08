// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
