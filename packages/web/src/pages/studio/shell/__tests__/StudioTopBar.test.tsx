// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup() {
  return render(
    <MemoryRouter>
      <StudioTopBar />
    </MemoryRouter>,
  );
}

describe('StudioTopBar', () => {
  it('renders a banner landmark', () => {
    setup();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('wires the same shared language + theme switchers as the project top bar', () => {
    setup();
    // Studio renders the shared `features/preferences` switchers (identical
    // look + behavior to project), not bespoke studio-only buttons — so the
    // project testids are present here too.
    expect(screen.getByTestId('lang-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders the brand (real logo mark + Breatic) linking to /studio, with no switcher or search', () => {
    setup();
    // The studio switcher moved to the persistent rail and search is dropped
    // this version, so the top bar is just brand + tools.
    const home = screen.getByRole('link', { name: 'Studio home' });
    expect(home).toHaveAttribute('href', '/studio');
    expect(screen.getByText('Breatic')).toBeInTheDocument();
    // The brand uses the shared REAL logo mark (the same `BrandMark` atom the
    // project top bar renders), not the old "b" placeholder square.
    expect(screen.getByTestId('top-bar-logo')).toBeInTheDocument();
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
