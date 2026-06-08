// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Tabs } from '@web/components/ui/tabs';
import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioType } from '@web/pages/studio/shared/studio-types';

function setup(
  studioType: StudioType,
  counts?: Partial<Record<'projects' | 'collections' | 'members', number>>,
) {
  // Tabs Root provides the Radix tablist context StudioTabBar renders into.
  return render(
    <Tabs value='projects'>
      <StudioTabBar studioType={studioType} counts={counts} />
    </Tabs>,
  );
}

describe('StudioTabBar', () => {
  it('renders all 6 tabs for a team studio, in spec order', () => {
    setup('team');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    // Test boot locale is English (vitest.setup seeds en + setLocale('en')).
    // Works sits at the 3rd position (spec §6.1), not the end.
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Projects',
      'Collections',
      'Works',
      'Members',
      'Credits',
      'Settings',
    ]);
  });

  it('shows all 6 tabs for a personal studio (Members read-only, A 方案)', () => {
    setup('personal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    expect(
      screen.getByRole('tab', { name: 'Members' }),
    ).toBeInTheDocument();
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Projects',
      'Collections',
      'Works',
      'Members',
      'Credits',
      'Settings',
    ]);
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

  it('shows a count chip on projects / collections / members when counts are given', () => {
    setup('team', { projects: 6, collections: 2, members: 4 });
    expect(screen.getByRole('tab', { name: /Projects/ })).toHaveTextContent('6');
    expect(screen.getByRole('tab', { name: /Collections/ })).toHaveTextContent(
      '2',
    );
    expect(screen.getByRole('tab', { name: /Members/ })).toHaveTextContent('4');
    // Credits / Settings never carry a count (mock定稿).
    expect(screen.getByRole('tab', { name: 'Credits' })).toBeInTheDocument();
  });

  it('omits the count chip for a tab whose count is absent', () => {
    setup('team', { projects: 6 });
    expect(screen.getByRole('tab', { name: /Projects/ })).toHaveTextContent('6');
    // Collections count not provided → exact label, no trailing number.
    expect(
      screen.getByRole('tab', { name: 'Collections' }),
    ).toBeInTheDocument();
  });
});
