// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import StudioPage from '@web/pages/studio/StudioPage';
import {
  STUB_RECENT_COLLECTIONS,
  STUB_RECENT_PROJECTS,
} from '@web/pages/studio/recent/recent-stub';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup() {
  return render(
    <MemoryRouter>
      <StudioPage />
    </MemoryRouter>,
  );
}

describe('StudioPage (recent landing)', () => {
  it('renders the top-bar banner', () => {
    setup();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('renders a card link for every stub recent item', () => {
    setup();
    // Card links + the logo home link; assert at least one per recent item.
    expect(screen.getAllByRole('link').length).toBeGreaterThanOrEqual(
      STUB_RECENT_PROJECTS.length + STUB_RECENT_COLLECTIONS.length,
    );
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
