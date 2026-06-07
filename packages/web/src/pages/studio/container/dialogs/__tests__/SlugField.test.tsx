// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import { ITEM_SLUG_BOUNDS } from '@web/pages/studio/container/dialogs/slug-util';

const BASE = {
  id: 'demo-slug',
  label: 'Handle',
  value: '',
  onChange: () => {},
  bounds: ITEM_SLUG_BOUNDS,
} as const;

describe('SlugField helper', () => {
  it('shows the always-on muted helper text when one is provided', () => {
    render(<SlugField {...BASE} error={null} helper='Part of the URL.' />);
    const helper = screen.getByText('Part of the URL.');
    expect(helper).toBeInTheDocument();
    // The input is described by the helper for screen readers.
    expect(screen.getByLabelText('Handle')).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('demo-slug-helper'),
    );
  });

  it('keeps the helper visible alongside a validation error', () => {
    render(<SlugField {...BASE} error='format' helper='Part of the URL.' />);
    expect(screen.getByText('Part of the URL.')).toBeInTheDocument();
    expect(
      screen.getByText('Lowercase letters, numbers and hyphens only.'),
    ).toBeInTheDocument();
    // Both the helper and the error are referenced for assistive tech.
    const described = screen
      .getByLabelText('Handle')
      .getAttribute('aria-describedby');
    expect(described).toContain('demo-slug-helper');
    expect(described).toContain('demo-slug-error');
  });

  it('renders no helper line when none is provided', () => {
    render(<SlugField {...BASE} error={null} />);
    expect(screen.queryByTestId('demo-slug-helper')).not.toBeInTheDocument();
  });
});
