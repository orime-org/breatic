// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RecentLanding } from '@web/pages/studio/recent/RecentLanding';
import {
  STUB_RECENT_COLLECTIONS,
  STUB_RECENT_PROJECTS,
} from '@web/pages/studio/recent/recent-stub';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(
  projects = [...STUB_RECENT_PROJECTS],
  collections = [...STUB_RECENT_COLLECTIONS],
) {
  return render(
    <MemoryRouter>
      <RecentLanding projects={projects} collections={collections} />
    </MemoryRouter>,
  );
}

describe('RecentLanding', () => {
  it('renders one card link per item across both sections', () => {
    setup();
    expect(screen.getAllByRole('link')).toHaveLength(
      STUB_RECENT_PROJECTS.length + STUB_RECENT_COLLECTIONS.length,
    );
  });

  it('renders every project + collection name', () => {
    setup();
    for (const item of [...STUB_RECENT_PROJECTS, ...STUB_RECENT_COLLECTIONS]) {
      expect(screen.getByText(item.name)).toBeInTheDocument();
    }
  });

  it('renders no card links when both sections are empty', () => {
    setup([], []);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
