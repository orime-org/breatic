// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Somebody coming online has to make this page re-fetch the roster.
 *
 * That is the mechanism keeping names current: nothing is pushed over the
 * wire, so a rename only ever reaches other people because their client asks
 * again when the renamed person shows up. It hangs on one call in ProjectPage,
 * and deleting that call breaks nothing visible to types, lint or any other
 * test — collaborators who join after you simply stay nameless forever.
 *
 * So this asserts the OUTCOME, not the call: an id appearing in the online set
 * must produce a real second request for the member list. Spying on the hook
 * would pass just as happily if the hook were wired to a query key that
 * matches nothing.
 *
 * The second half of the file covers the other end: that the page PUBLISHES
 * the roster it fetched. Every editor below reads it from context, so this one
 * line is now the whole path between "we know everyone's name" and "carets are
 * named" — it replaced a chain of six hand-written forwards, four of which
 * turned out to be severable with the entire suite still green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';

/** The online set the mocked meta hook reports; mutated between renders. */
let onlineNow: ReadonlySet<string> = new Set<string>();

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: () => ({
      spaces: [],
      openTabIds: [],
      onlineUserIds: onlineNow,
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

/** Every roster value the page hands to the provider, in order. */
const publishedRosters: Array<{ resolve: (id: string) => string | null } | null> = [];
vi.mock('@web/features/collab-editor/collaborator-names-context', async (orig) => {
  const actual = await orig<
    typeof import('@web/features/collab-editor/collaborator-names-context')
  >();
  return {
    ...actual,
    CollaboratorNamesProvider: ({
      value,
      children,
    }: {
      value: { resolve: (id: string) => string | null } | null;
      children: React.ReactNode;
    }): React.ReactNode => {
      publishedRosters.push(value);
      return children;
    },
  };
});

const listMock = vi.fn();
const profilesMock = vi.fn();
// The roster hook imports these modules directly, not through the barrel, so
// the barrel is not the thing to intercept.
vi.mock('@web/data/api/members', () => ({
  membersApi: { list: (...a: unknown[]) => listMock(...a) },
}));
vi.mock('@web/data/api/users', () => ({
  usersApi: { getByIds: (...a: unknown[]) => profilesMock(...a) },
}));

const getMock = vi.fn();
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
  };
});

const { default: ProjectPage } = await import('@web/pages/project/ProjectPage');

/**
 * One client for the whole test, built per case. Rebuilding it inside the
 * wrapper would hand every re-render a fresh empty cache, which both hides
 * the thing under test and invents re-fetches that never happen in the app.
 */
let queryClient: QueryClient;

function AllProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/** Render the page at a project route. */
function renderPage() {
  return rtlRender(
    <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
      <Routes>
        <Route path='/project/:projectId' element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: AllProviders },
  );
}

describe('ProjectPage roster wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishedRosters.length = 0;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    onlineNow = new Set<string>();
    listMock.mockResolvedValue([{ userId: 'u-them', role: 'editor' }]);
    profilesMock.mockResolvedValue([
      { id: 'u-them', name: 'Them', email: 't@e.com' },
    ]);
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
    useUIStore.setState({ chatPanelCollapsed: false });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('re-fetches the member list when somebody comes online', async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    onlineNow = new Set(['u-them']);
    rerender(
      <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
        <Routes>
          <Route path='/project/:projectId' element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch while the online set stays empty', async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    rerender(
      <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
        <Routes>
          <Route path='/project/:projectId' element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('publishes the fetched roster so editors below can resolve names', async () => {
    // The one remaining link. Delete the provider and every editor on the page
    // silently falls back to nameless carets — types, lint and the rest of the
    // suite all stay green, which is exactly how the four forwarding links this
    // replaced managed to be severable.
    renderPage();

    await waitFor(() => {
      const latest = publishedRosters.at(-1);
      expect(latest?.resolve('u-them')).toBe('Them');
    });
  });

  it('publishes a resolver that names nobody before the roster lands', async () => {
    // The page publishes from its first render, when the fetch has not
    // returned. What it publishes is a working resolver over an empty roster,
    // not null — so an editor that mounts early asks and is told "nobody",
    // which is how a caret ends up as a bare colour line rather than a crash
    // or a wait.
    renderPage();
    expect(publishedRosters[0]?.resolve('u-them')).toBeNull();

    await waitFor(() =>
      expect(publishedRosters.at(-1)?.resolve('u-them')).toBe('Them'),
    );
  });
});
