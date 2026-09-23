// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { projectsApi } from '@web/data/api';
import { ApiException } from '@web/data/api/types';
import type { ProjectDetail } from '@web/data/api/projects';
import ProjectPage from '../ProjectPage';

vi.mock('@web/data/api', async original => {
  const real = await original<typeof import('@web/data/api')>();
  return { ...real, projectsApi: { ...real.projectsApi, get: vi.fn() } };
});
// An editor/collab sentinel: reaching this means the resource gate opened.
vi.mock('@web/data/yjs/collab-socket', async original => ({
  ...await original<typeof import('@web/data/yjs/collab-socket')>(),
  CollabSocketProvider: () => <div data-testid='editor'>Editor</div>,
}));
const id = '11111111-1111-4111-8111-111111111111';
const project: ProjectDetail = {
  id, name: 'Resource test', description: null, thumbnailUrl: null, createdAt: '', updatedAt: '',
  studioId: 'studio', createdByUserId: 'user', myRole: 'owner', deletedAt: null,
};
function Location() { return <p data-testid='address'>{useLocation().pathname}</p>; }
function setup(suffix = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/project/example-${id}${suffix}`]}>
    <Routes><Route path='/project/:projectId/*' element={<ProjectPage />} /><Route path='/project/:projectId/access' element={<p>Access required</p>} /></Routes>
    <Location />
  </MemoryRouter></QueryClientProvider>);
  return client;
}
beforeEach(() => vi.clearAllMocks());
describe('Project resource entry', () => {
  it('waits for the real resource before mounting the editor', async () => {
    let resolve!: (value: ProjectDetail) => void;
    vi.mocked(projectsApi.get).mockReturnValue(new Promise(done => { resolve = done; }));
    setup('/ignored/nested');
    expect(screen.queryByTestId('editor')).toBeNull();
    await act(async () => resolve(project));
    expect(await screen.findByTestId('editor')).toBeVisible();
    expect(projectsApi.get).toHaveBeenCalledExactlyOnceWith(id);
    expect(screen.getByTestId('address').textContent).toBe(`/project/example-${id}/ignored/nested`);
  });
  it('shows 404 without mounting the editor or rewriting the address', async () => {
    vi.mocked(projectsApi.get).mockRejectedValue(new ApiException({ status: 404, message: 'missing' }));
    setup();
    expect(await screen.findByTestId('not-found-page')).toBeVisible();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(projectsApi.get).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('address').textContent).toBe(`/project/example-${id}`);
  });
  it('keeps forbidden responses on the existing access page', async () => {
    vi.mocked(projectsApi.get).mockRejectedValue(new ApiException({ status: 403, message: 'forbidden' }));
    setup();
    expect(await screen.findByText('Access required')).toBeVisible();
    expect(screen.queryByTestId('not-found-page')).toBeNull();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(projectsApi.get).toHaveBeenCalledTimes(1);
  });
  it.each([0, 500])('keeps status %s separate from 404 and supports retry', async status => {
    vi.mocked(projectsApi.get).mockRejectedValue(new ApiException({ status, message: 'failed' }));
    setup();
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByTestId('not-found-page')).toBeNull();
    expect(screen.queryByTestId('editor')).toBeNull();
    vi.mocked(projectsApi.get).mockResolvedValue(project);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('editor')).toBeVisible();
  });
  it('does not remove a loaded editor on a background server failure', async () => {
    vi.mocked(projectsApi.get).mockResolvedValue(project);
    const client = setup();
    expect(await screen.findByTestId('editor')).toBeVisible();
    vi.mocked(projectsApi.get).mockRejectedValue(new ApiException({ status: 500, message: 'failed' }));
    await act(async () => { await client.invalidateQueries({ queryKey: ['project', id] }); });
    await waitFor(() => expect(client.getQueryState(['project', id])?.status).toBe('error'));
    expect(screen.getByTestId('editor')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
