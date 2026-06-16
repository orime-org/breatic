// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RecentCard } from '@web/pages/studio/recent/RecentCard';
import type { RecentItem } from '@web/pages/studio/recent/recent-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

const project: RecentItem = {
  id: 'id-1',
  kind: 'project',
  slug: 'cyberpunk-alley',
  name: 'Cyberpunk Alley',
  thumbnailUrl: null,
  lastOpenedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  studioId: 's-acme',
  studioName: 'Acme Studio',
  myRole: 'owner',
};

function setup(item: RecentItem = project) {
  return render(
    <MemoryRouter>
      <RecentCard item={item} />
    </MemoryRouter>,
  );
}

describe('RecentCard', () => {
  it('renders the item name', () => {
    setup();
    expect(screen.getByText('Cyberpunk Alley')).toBeInTheDocument();
  });

  it('renders the source studio name (cross-studio provenance)', () => {
    setup();
    expect(screen.getByText('Acme Studio')).toBeInTheDocument();
  });

  it('prefixes the time with the "opened" label (disambiguates from "modified")', () => {
    // The fixture was last opened 30 min ago → en renders "Opened 30 minutes ago".
    setup();
    expect(screen.getByText(/^Opened\b/i)).toBeInTheDocument();
  });

  it('links a project to /project/{slug}-{uuid}', () => {
    setup();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/project/cyberpunk-alley-id-1',
    );
  });

  it('links a collection to /collection/{slug}-{uuid}', () => {
    setup({
      ...project,
      kind: 'collection',
      slug: 'reference-moodboard',
      id: 'id-2',
    });
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/collection/reference-moodboard-id-2',
    );
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
