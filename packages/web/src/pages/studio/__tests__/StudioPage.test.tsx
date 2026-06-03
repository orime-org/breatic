// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import StudioPage from '@web/pages/studio/StudioPage';
import { useStudioStore } from '@web/stores';
import type { ProjectSummary } from '@web/data/api/projects';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

const DEMO_PROJECTS: ProjectSummary[] = [
  {
    id: 'p-1',
    name: 'Cyberpunk Concept',
    description: null,
    thumbnailUrl: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: 'p-2',
    name: 'BGM Exploration',
    description: null,
    thumbnailUrl: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 7).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
  },
  {
    id: 'p-3',
    name: 'Trailer v2',
    description: null,
    thumbnailUrl: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
  },
];

vi.mock('@web/data/api', () => ({
  projectsApi: {
    list: vi.fn(async () => DEMO_PROJECTS),
    create: vi.fn(),
    get: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
  },
}));

function setup() {
  // Fresh QueryClient per test so cache doesn't leak between cases.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StudioPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StudioPage', () => {
  it('has no a11y violations', async () => {
    const { container } = setup();
    // Wait for the project list to settle so axe scans the loaded UI.
    await screen.findByText('Cyberpunk Concept');
    await expectNoA11yViolations(container);
  });

  beforeEach(() => {
    useStudioStore.setState({
      search: '',
      sortKey: 'updated',
      sortOrder: 'desc',
      filterOwnerOnly: false,
    });
  });

  it('renders Projects header + nav + grid by default', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Projects/i })).toBeInTheDocument();
  });

  it('renders 3 demo project cards + 1 new card', async () => {
    setup();
    // List query resolves asynchronously; await first card render.
    const links = await screen.findAllByRole('link', { name: /Open project/i });
    expect(links).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Create new project' })).toBeInTheDocument();
  });

  it('switching to Settings renders Settings panel', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /Settings/i }));
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
  });

  it('search filter narrows visible cards', async () => {
    const user = userEvent.setup();
    setup();
    // Wait for initial render before typing into search.
    await screen.findAllByRole('link', { name: /Open project/i });
    await user.type(screen.getByPlaceholderText('Search…'), 'cyber');
    const links = screen.getAllByRole('link', { name: /Open project/i });
    expect(links).toHaveLength(1);
    expect(screen.getByText('Cyberpunk Concept')).toBeInTheDocument();
  });
});
