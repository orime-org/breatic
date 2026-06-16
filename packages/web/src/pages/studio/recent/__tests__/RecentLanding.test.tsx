// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import type { RecentItem } from '@web/pages/studio/recent/recent-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Local fixtures — the Recent landing's data comes from `GET /studios/recent`
// (mapped to the view model upstream); these tests own their sample items.
const ITEM: RecentItem = {
  id: 'r1',
  kind: 'project',
  slug: 'demo',
  name: 'Demo Project',
  thumbnailUrl: null,
  lastOpenedAt: '2026-06-05T05:40:00.000Z',
  studioId: 's1',
  studioName: 'Acme Studio',
  myRole: 'owner',
};

function setup(
  projects: RecentItem[] = [ITEM],
  collections: RecentItem[] = [],
) {
  return render(
    <MemoryRouter>
      <RecentLanding projects={projects} collections={collections} />
    </MemoryRouter>,
  );
}

describe('RecentLanding', () => {
  it('renders one card link per recent item when there is content', () => {
    setup([ITEM, { ...ITEM, id: 'r2', name: 'Second Project' }], []);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByText('Demo Project')).toBeInTheDocument();
    expect(screen.getByText('Second Project')).toBeInTheDocument();
  });

  it('shows a PASSIVE recent empty state — no cards and NO create-project button', () => {
    setup([], []);
    // No card links in the empty state.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    // The empty-state create CTA was removed (2026-06-16): creating is one
    // click away in the rail, so the landing does not duplicate it.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no a11y violations (content + empty)', async () => {
    const withContent = setup();
    await expectNoA11yViolations(withContent.container);
    withContent.unmount();
    const empty = setup([], []);
    await expectNoA11yViolations(empty.container);
  });
});
