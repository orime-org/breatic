// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NonMemberView } from '@web/pages/studio/container/NonMemberView';

// Test boot locale is English (vitest.setup seeds en + setLocale('en')).
describe('NonMemberView (spec §6.3 — non-member center: no tabs)', () => {
  it('renders the "Works" section title', () => {
    render(<NonMemberView />);
    expect(
      screen.getByRole('heading', { name: 'Works' }),
    ).toBeInTheDocument();
  });

  it('renders the "no published works" empty state', () => {
    render(<NonMemberView />);
    expect(
      screen.getByText('This Studio has no published works.'),
    ).toBeInTheDocument();
  });

  it('renders no tablist (a non-member sees no tabs, spec §6.3)', () => {
    render(<NonMemberView />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
