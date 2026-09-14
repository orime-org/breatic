// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The wire between the comment button and the armed annotation tool (#1881).
 *
 * The two ends each have their own tests — the menu lights a button it is told
 * is armed, the canvas drops a note where the armed tool is spent — and the
 * line between them is a prop and a callback on this page. Untested, the
 * button can go on lighting from a flag nothing sets and both ends stay green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCanvasStore } from '@web/stores/canvas';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';

/** A provider object the page only holds and passes on. */
const fakeProvider = { on: (): void => {}, off: (): void => {} } as never;

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: () => ({
      spaces: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Board',
          type: 'canvas' as const,
          createdAt: 1,
        },
      ],
      users: new Map(),
      synced: true,
      provider: fakeProvider,
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

// The board itself is not under test here — the wire from the chrome to the
// store is. Mounting a real canvas would bring a WebSocket with it.
vi.mock('@web/pages/project/SpaceOutlet', () => ({
  SpaceOutlet: (): null => null,
}));

const getMock = vi.fn();
const membersListMock = vi.fn();
vi.mock('@web/data/api', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api')>(
    '@web/data/api',
  );
  return {
    ...actual,
    projectsApi: { ...actual.projectsApi, get: (...a: unknown[]) => getMock(...a) },
    membersApi: {
      ...actual.membersApi,
      list: (...a: unknown[]) => membersListMock(...a),
    },
  };
});

import ProjectPage from '@web/pages/project/ProjectPage';

/**
 * The providers the page expects around it.
 * @param root0 - Wrapper props.
 * @param root0.children - The tree under test.
 * @returns The wrapped tree.
 */
function AllProviders({ children }: { children: React.ReactNode }) {
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

/** Mount the page as an editor, who may leave notes. */
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
    myRole: 'editor',
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

describe('the comment button and the annotation tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCanvasStore.getState().reset();
    useUIStore.setState({ chatPanelCollapsed: false });
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

  it('arms the tool on the press, and the button says so', async () => {
    const user = userEvent.setup();
    setup();
    const comment = await screen.findByTestId('tool-comment');
    expect(comment).toHaveAttribute('aria-pressed', 'false');
    expect(useCanvasStore.getState().placingAnnotation).toBe(false);

    await user.click(comment);

    expect(useCanvasStore.getState().placingAnnotation).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId('tool-comment')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});
