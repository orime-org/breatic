// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/projects', () => ({
  projectsApi: { create: vi.fn() },
}));
import { projectsApi } from '@web/data/api/projects';
import { useCreateProject } from '@web/pages/studio/container/dialogs/use-create-project';

function Harness(): React.JSX.Element {
  const create = useCreateProject([]);
  const location = useLocation();
  return (
    <div>
      <button
        type='button'
        onClick={() =>
          create({
            name: 'My Project',
            slug: 'my-proj',
            description: '',
            visibility: 'studio',
            spaceType: 'canvas',
            studioId: 's-1',
          })
        }
      >
        go
      </button>
      <div data-testid='loc'>{location.pathname}</div>
    </div>
  );
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/studio/acme']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useCreateProject — navigates INTO the new project (decision B)', () => {
  it('on success, routes to /project/{slug}-{id} (not back to the studio)', async () => {
    vi.mocked(projectsApi.create).mockResolvedValue({
      id: 'new-proj',
      studioId: 's-1',
      name: 'My Project',
      description: null,
      thumbnailUrl: null,
      createdByUserId: 'u-1',
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
      deletedAt: null,
    });
    setup();
    expect(screen.getByTestId('loc')).toHaveTextContent('/studio/acme');

    screen.getByRole('button', { name: 'go' }).click();

    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent(
        '/project/my-proj-new-proj',
      ),
    );
    expect(projectsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: 's-1', slug: 'my-proj' }),
    );
  });
});
