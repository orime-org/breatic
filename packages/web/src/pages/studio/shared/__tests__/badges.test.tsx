// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  CreditLotBadge,
  RoleBadge,
  StudioTypePill,
  VisibilityBadge,
} from '@web/pages/studio/shared/badges';

// Boot locale is English (vitest.setup seeds en + setLocale('en')). Every
// badge must carry TEXT, not color alone (spec §3.5 a11y).
describe('studio badges (spec §3.5)', () => {
  it('visibility badge labels studio-visible and private', () => {
    const { rerender } = render(<VisibilityBadge visibility='studio' />);
    expect(screen.getByText('Studio-visible')).toBeInTheDocument();
    rerender(<VisibilityBadge visibility='private' />);
    expect(screen.getByText('Private')).toBeInTheDocument();
  });

  it('role badge labels the role', () => {
    const { rerender } = render(<RoleBadge itemRole='owner' />);
    expect(screen.getByText('Owner')).toBeInTheDocument();
    rerender(<RoleBadge itemRole='viewer' />);
    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });

  it('studio type pill labels personal and team', () => {
    const { rerender } = render(<StudioTypePill type='team' />);
    expect(screen.getByText('Team')).toBeInTheDocument();
    rerender(<StudioTypePill type='personal' />);
    expect(screen.getByText('Personal')).toBeInTheDocument();
  });

  it('credit lot badge distinguishes paid, gift and expiring', () => {
    const { rerender } = render(<CreditLotBadge source='paid' />);
    expect(screen.getByText(/Permanent/)).toBeInTheDocument();
    rerender(<CreditLotBadge source='promo' />);
    expect(screen.getByText(/Gift/)).toBeInTheDocument();
    rerender(<CreditLotBadge source='promo' expiringDays={7} />);
    expect(screen.getByText(/7 days/)).toBeInTheDocument();
  });
});
