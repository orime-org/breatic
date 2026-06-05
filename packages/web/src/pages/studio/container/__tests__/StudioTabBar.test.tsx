// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Tabs } from '@web/components/ui/tabs';
import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioType } from '@web/pages/studio/shared/studio-types';

function setup(studioType: StudioType) {
  // Tabs Root provides the Radix tablist context StudioTabBar renders into.
  return render(
    <Tabs value='projects'>
      <StudioTabBar studioType={studioType} />
    </Tabs>,
  );
}

describe('StudioTabBar', () => {
  it('renders all 5 tabs for a team studio, in spec order', () => {
    setup('team');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    // Test boot locale is English (vitest.setup seeds en + setLocale('en')).
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Projects',
      'Collections',
      'Members',
      'Credits',
      'Settings',
    ]);
  });

  it('drops the Members tab for a personal studio (4 tabs)', () => {
    setup('personal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(screen.queryByRole('tab', { name: 'Members' })).toBeNull();
  });

  it('marks the active tab with aria-selected', () => {
    setup('team');
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Collections' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });
});
