// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Opening a Project that lives in another region (inner#1955, acceptance 2).
 * The page learns the Project's region from the global directory, makes it the
 * current region before asking for the Project, and dials that region's
 * collab. A build with one region asks the directory nothing and keeps
 * today's collab address.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { projectsApi } from '@web/data/api';
import type { ProjectDetail } from '@web/data/api/projects';
import { directoryApi } from '@web/data/api/directory';
import { getCurrentRegion, getRegionConfig, parseRegionConfig, setCurrentRegion } from '@web/data/api/regions';
import { ApiException } from '@web/data/api/types';
import ProjectPage from '../ProjectPage';

vi.mock('@web/data/api', async original => {
  const real = await original<typeof import('@web/data/api')>();
  return { ...real, projectsApi: { ...real.projectsApi, get: vi.fn() } };
});
vi.mock('@web/data/api/directory', () => ({
  directoryApi: { project: vi.fn(), studio: vi.fn() },
}));
vi.mock('@web/data/api/regions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/regions')>()),
  getRegionConfig: vi.fn(),
}));
const collabUrls = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('@web/data/yjs/collab-socket', async original => ({
  ...await original<typeof import('@web/data/yjs/collab-socket')>(),
  CollabSocketProvider: ({ url }: { url?: string }) => {
    collabUrls.push(url);
    return <div data-testid='editor'>Editor</div>;
  },
}));

const TWO_REGIONS = parseRegionConfig(
  JSON.stringify({
    global: 'us-west',
    regions: {
      'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/collab' },
      sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/collab' },
    },
  }),
);

const id = '22222222-2222-4222-8222-222222222222';
const project: ProjectDetail = {
  id, name: 'Region test', description: null, thumbnailUrl: null, createdAt: '', updatedAt: '',
  studioId: 'studio', createdByUserId: 'user', myRole: 'owner', deletedAt: null, archivedAt: null,
  canManageMeta: true, canRestore: false, canLeave: false,
};

/** Open the Project page at this test's Project. */
function open(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/project/region-${id}`]}>
    <Routes><Route path='/project/:projectId/*' element={<ProjectPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  collabUrls.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  setCurrentRegion(null);
});

describe('opening a Project in another region', () => {
  it('asks the Project from its region and dials that region\'s collab', async () => {
    vi.mocked(getRegionConfig).mockReturnValue(TWO_REGIONS);
    vi.mocked(directoryApi.project).mockResolvedValue({ region: 'sg' });
    let regionWhenAsked: string | null | undefined;
    vi.mocked(projectsApi.get).mockImplementation(async () => {
      regionWhenAsked = getCurrentRegion();
      return project;
    });

    open();

    await screen.findByTestId('editor');
    expect(directoryApi.project).toHaveBeenCalledWith(id);
    expect(regionWhenAsked).toBe('sg');
    expect(collabUrls.at(-1)).toBe('wss://sg.example.test/collab');
  });

  it('asks the directory nothing in a build with one region and keeps today\'s collab address', async () => {
    vi.mocked(getRegionConfig).mockReturnValue(null);
    vi.mocked(projectsApi.get).mockResolvedValue(project);

    open();

    await waitFor(() => expect(screen.getByTestId('editor')).toBeInTheDocument());
    expect(directoryApi.project).not.toHaveBeenCalled();
    expect(collabUrls.at(-1)).toBeUndefined();
  });

  it('says the Project cannot be reached when its region does not answer, and offers a retry', async () => {
    vi.mocked(getRegionConfig).mockReturnValue(TWO_REGIONS);
    vi.mocked(directoryApi.project).mockResolvedValue({ region: 'sg' });
    vi.mocked(projectsApi.get).mockRejectedValue(new ApiException({ status: 0, message: 'offline', fromServer: false, network: true }));

    open();

    expect(await screen.findByText('This Project can\'t be reached right now', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
