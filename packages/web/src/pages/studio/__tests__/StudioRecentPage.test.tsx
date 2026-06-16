// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import StudioRecentPage from '@web/pages/studio/StudioRecentPage';
import type { RecentFeedItem } from '@web/data/api/studios';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { getRecent: vi.fn() },
}));
import { studiosApi } from '@web/data/api/studios';

const WIRE: RecentFeedItem = {
  projectId: 'p1',
  name: 'Demo Project',
  slug: 'demo',
  thumbnailUrl: null,
  studioId: 's1',
  studioName: 'Acme Studio',
  myRole: 'owner',
  lastOpenedAt: '2026-06-05T05:40:00.000Z',
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudioRecentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudioRecentPage (fetches + maps the cross-studio recent feed)', () => {
  it('renders a card per fetched recent project (wire row mapped to the view)', async () => {
    vi.mocked(studiosApi.getRecent).mockResolvedValue([
      WIRE,
      { ...WIRE, projectId: 'p2', name: 'Second Project' },
    ]);
    setup();
    // The mapped cards appear once the query resolves; the card link target
    // proves the wire→view mapping (projectId → /project/{slug}-{id}).
    expect(await screen.findByText('Demo Project')).toBeInTheDocument();
    expect(screen.getByText('Second Project')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/project/demo-p1');
  });

  it('shows the PASSIVE empty state (no cards, no create button) for an empty feed', async () => {
    vi.mocked(studiosApi.getRecent).mockResolvedValue([]);
    setup();
    // Wait for the query to settle, then assert the empty state has no CTA.
    expect(
      await screen.findByText(/Nothing recent yet/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a loading spinner while the feed is in flight', () => {
    // A never-resolving promise keeps the query pending.
    vi.mocked(studiosApi.getRecent).mockReturnValue(new Promise(() => {}));
    setup();
    // The spinner carries the generic loading aria-label.
    expect(screen.getByLabelText('Loading...')).toBeInTheDocument();
  });

  it('shows a muted error line when the feed fails to load', async () => {
    vi.mocked(studiosApi.getRecent).mockRejectedValue(new Error('boom'));
    setup();
    expect(
      await screen.findByText(/Couldn’t load your recent projects/i),
    ).toBeInTheDocument();
  });

  it('has no a11y violations (loaded with content)', async () => {
    vi.mocked(studiosApi.getRecent).mockResolvedValue([WIRE]);
    const { container } = setup();
    await screen.findByText('Demo Project');
    await expectNoA11yViolations(container);
  });
});
