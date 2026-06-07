// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import StudioRecentPage from '@web/pages/studio/StudioRecentPage';
import {
  STUB_RECENT_COLLECTIONS,
  STUB_RECENT_PROJECTS,
} from '@web/pages/studio/recent/recent-stub';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup() {
  return render(
    <MemoryRouter>
      <StudioRecentPage />
    </MemoryRouter>,
  );
}

describe('StudioRecentPage (cross-studio recent landing — rendered in the layout Outlet)', () => {
  it('renders a card link for every stub recent item', () => {
    setup();
    // The top bar + its logo link now live in StudioLayout, so the page itself
    // renders only the recent cards (one link per recent project / collection).
    expect(screen.getAllByRole('link').length).toBeGreaterThanOrEqual(
      STUB_RECENT_PROJECTS.length + STUB_RECENT_COLLECTIONS.length,
    );
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
