// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page shown while the open Studio's or Project's region cannot be
 * reached (inner#1955). The Project page has no rail or top bar around it, so
 * it offers a way back besides retrying.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RegionUnavailable } from '@web/components/RegionUnavailable';

describe('RegionUnavailable', () => {
  it('offers a way back home on the Project page', () => {
    render(<MemoryRouter><RegionUnavailable kind='project' onRetry={() => undefined} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/studio');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('leaves the way back to the rail on the Studio page', () => {
    render(<MemoryRouter><RegionUnavailable kind='studio' onRetry={() => undefined} /></MemoryRouter>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
