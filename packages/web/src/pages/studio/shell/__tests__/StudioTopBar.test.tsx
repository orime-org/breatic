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

  it('renders the three tool buttons (search / language / theme)', () => {
    setup();
    // logo links home; switcher + 3 tool buttons are <button>s.
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(3);
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
