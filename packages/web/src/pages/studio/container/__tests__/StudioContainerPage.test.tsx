// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import StudioContainerPage from '@web/pages/studio/container/StudioContainerPage';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(slug = 'acme-studio') {
  return render(
    <MemoryRouter initialEntries={[`/studio/${slug}`]}>
      <Routes>
        <Route path='/studio/:slug' element={<StudioContainerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StudioContainerPage', () => {
  it('renders the top-bar banner, the studio header and a 5-tab tablist', () => {
    setup('acme-studio');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    // The studio name appears in both the top-bar switcher and the shead.
    expect(screen.getAllByText('Acme Studio').length).toBeGreaterThanOrEqual(2);
    // The Team pill is unique to the studio header (proves the shead rendered).
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('defaults to the Projects tab panel', () => {
    setup('acme-studio');
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('switches the visible panel when another tab is clicked', async () => {
    const user = userEvent.setup();
    setup('acme-studio');
    await user.click(screen.getByRole('tab', { name: 'Credits' }));
    expect(screen.getByRole('tab', { name: 'Credits' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('renders 4 tabs for a personal studio (no Members)', () => {
    setup('alex');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('tab', { name: 'Members' })).toBeNull();
  });

  it('has no a11y violations', async () => {
    const { container } = setup('acme-studio');
    await expectNoA11yViolations(container);
  });
});
