// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: () => ({
      spaces: [],
      openTabIds: [],
      users: new Map(),
      synced: true,
      provider: null,
      status: 'connected' as const,
      authFailedReason: null,
    }),
  };
});

vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: () => undefined,
}));

vi.mock('@web/pages/project/LeaveProjectGuard', () => ({
  LeaveProjectGuard: () => null,
}));

const getMock = vi.fn();
const membersListMock = vi.fn();
vi.mock('@web/data/api', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api')>(
    '@web/data/api',
  );
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: (...a: unknown[]) => getMock(...a),
    },
    membersApi: {
      ...actual.membersApi,
      list: (...a: unknown[]) => membersListMock(...a),
    },
  };
});

import ProjectPage from '@web/pages/project/ProjectPage';

/**
 * Wraps a tree in the providers ProjectPage expects.
 * @param root0 - Props.
 * @param root0.children - The tree under test.
 * @returns The wrapped tree.
 */
function AllProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

const render = (ui: React.ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: AllProviders, ...options });

/**
 * Renders the project page as an owner.
 */
function setup(): void {
  getMock.mockResolvedValue({
    id: PID,
    name: 'Demo project',
    description: null,
    thumbnailUrl: null,
    createdAt: '',
    updatedAt: '',
    studioId: 's1',
    createdByUserId: 'u-me',
    myRole: 'owner',
    deletedAt: null,
  });
  membersListMock.mockResolvedValue({ members: [] });
  render(
    <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
      <Routes>
        <Route path='/project/:projectId' element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Dispatches a bubbling pointerdown from `el`.
 * @param el - Where the press lands.
 */
function press(el: Element): void {
  el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

describe('ProjectPage — active region wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ chatPanelCollapsed: false, activeRegion: 'space' });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
        membershipTier: 'base',
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('marks the agent column as the agent region', async () => {
    setup();
    const column = await screen.findByTestId('agent-column');
    expect(column.getAttribute('data-region')).toBe('agent');
  });

  it('marks the space column as the space region', async () => {
    setup();
    await screen.findByTestId('agent-column');
    const space = document.querySelector('[data-region="space"]');
    expect(space).not.toBeNull();
    // The tab bar lives inside it, which is what makes the tab bar part of
    // the space region without a rule of its own.
    expect(space?.querySelector('[data-testid="space-tab-bar"]')).not.toBeNull();
  });

  it('a press in the agent column hands it the region', async () => {
    setup();
    press(await screen.findByTestId('agent-column'));
    expect(useUIStore.getState().activeRegion).toBe('agent');
  });

  it('a press in the space column hands it back', async () => {
    setup();
    await screen.findByTestId('agent-column');
    useUIStore.getState().setActiveRegion('agent');
    const space = document.querySelector('[data-region="space"]');
    press(space as Element);
    expect(useUIStore.getState().activeRegion).toBe('space');
  });

  it('a press in the top bar leaves the region alone', async () => {
    setup();
    await screen.findByTestId('agent-column');
    useUIStore.getState().setActiveRegion('agent');
    press(await screen.findByTestId('top-bar'));
    expect(useUIStore.getState().activeRegion).toBe('agent');
  });

  // The gate itself is covered in lib/__tests__/use-block-select-all.test.tsx.
  // What this pins is that the project page is the one that mounts it, which
  // is what keeps select-all on the studio routes and the login page as it
  // was.
  it('swallows select-all while the project page is on screen', async () => {
    setup();
    const column = await screen.findByTestId('agent-column');
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    column.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
