// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WorksTab } from '@web/pages/studio/container/tabs/WorksTab';

// Test boot locale is English (vitest.setup seeds en + setLocale('en')).
describe('WorksTab (spec §6.2 — empty placeholder shell)', () => {
  it('renders the "no works yet" empty state', () => {
    render(<WorksTab />);
    expect(screen.getByText('No works yet')).toBeInTheDocument();
  });

  it('renders the hint that works appear once a project is published', () => {
    render(<WorksTab />);
    expect(
      screen.getByText('Works appear here once a project is published.'),
    ).toBeInTheDocument();
  });
});
