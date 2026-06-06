// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StudioHeader } from '@web/pages/studio/container/StudioHeader';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

const TEAM: StudioDetail = {
  id: 's-acme',
  slug: 'acme-studio',
  name: 'Acme Studio',
  type: 'team',
  memberCount: 4,
  myStudioRole: 'admin',
};

const PERSONAL: StudioDetail = {
  id: 's-personal',
  slug: 'alex',
  name: 'Alex',
  type: 'personal',
  memberCount: null,
  myStudioRole: 'admin',
};

describe('StudioHeader', () => {
  it('shows name, team pill, slug and member count for a team studio', () => {
    render(<StudioHeader studio={TEAM} />);
    expect(screen.getByText('Acme Studio')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('acme-studio')).toBeInTheDocument();
    // ICU "{count} members" → "4 members".
    expect(screen.getByText(/4 members/)).toBeInTheDocument();
  });

  it('shows the personal pill and hides member count for a personal studio', () => {
    render(<StudioHeader studio={PERSONAL} />);
    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('alex')).toBeInTheDocument();
    expect(screen.queryByText(/members/)).toBeNull();
  });
});
