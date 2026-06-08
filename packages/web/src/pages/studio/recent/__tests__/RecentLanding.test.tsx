// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import type { RecentItem } from '@web/pages/studio/recent/recent-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Local fixtures — the Recent landing's real data comes from a future
// `GET /studio/recent`; the tests own their sample items (no shared stub).
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
  onCreateProject: () => void = () => {},
) {
  return render(
    <MemoryRouter>
      <RecentLanding
        projects={projects}
        collections={collections}
        onCreateProject={onCreateProject}
      />
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

  it('shows the recent empty state (no cards) with a create-project button that fires onCreateProject', () => {
    const onCreate = vi.fn();
    setup([], [], onCreate);
    // No card links in the empty state.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    // The empty state offers the create-project entry (neutral mock §recent-empty).
    const btn = screen.getByRole('button', { name: /New project/i });
    fireEvent.click(btn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('has no a11y violations (content + empty)', async () => {
    const withContent = setup();
    await expectNoA11yViolations(withContent.container);
    withContent.unmount();
    const empty = setup([], []);
    await expectNoA11yViolations(empty.container);
  });
});
