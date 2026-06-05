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

  it('keeps the search tool button alongside the switchers', () => {
    setup();
    // Test boot locale is English (vitest.setup seeds en + setLocale('en')).
    expect(
      screen.getByRole('button', { name: 'Search' }),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
