// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { StudioRailDrawer } from '@web/pages/studio/rail/StudioRailDrawer';

function setup() {
  return render(
    <MemoryRouter>
      <StudioRailDrawer
        studios={[]}
        activeSlug={null}
        onCreateProject={() => {}}
        onCreateStudio={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('StudioRailDrawer (narrow-screen rail)', () => {
  it('renders a hamburger button that hides at md and up', () => {
    setup();
    const button = screen.getByRole('button', { name: 'Open navigation' });
    // The persistent rail takes over at md, so the hamburger is md:hidden.
    expect(button.className).toContain('md:hidden');
  });

  it('opens a left drawer carrying the shared rail content on click', async () => {
    const user = userEvent.setup();
    setup();
    // Closed initially — the drawer content is not mounted.
    expect(screen.queryByTestId('studio-rail-drawer')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByTestId('studio-rail-drawer')).toBeInTheDocument();
    // The same StudioRailContent (the Recent nav link) renders inside.
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('shows a Breatic brand header so the close button gets its own row', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    // The drawer header carries the brand; this gives the vendor Sheet close
    // (X, absolute top-right) its own top row instead of overlapping the first
    // rail item ("Recent").
    expect(screen.getByText('Breatic')).toBeInTheDocument();
  });
});
