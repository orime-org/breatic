// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { ProjectUser } from '@web/data/yjs/project-meta';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { useCurrentUserStore, useUIStore } from '@web/stores';

const PID = '11111111-1111-4111-8111-111111111111';

/** The presence map the mocked meta hook reports; mutated between renders. */
let usersNow: ReadonlyMap<string, ProjectUser> = new Map();

/**
 * Build a presence map the way the server writes one.
 * @param flags - Who has a record, and whether it says online.
 * @returns The map the page hands to the roster refresh.
 */
function presence(
  flags: Record<string, boolean>,
): ReadonlyMap<string, ProjectUser> {
  return new Map(
    Object.entries(flags).map(([id, online]) => [
      id,
      { id, online, lastSeenAt: 1_000 },
    ]),
  );
}

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: () => ({
      spaces: [{ id: 's1', name: 'S1', type: 'canvas' }],
      openTabIds: ['s1'],
      users: usersNow,
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

// The space body is replaced by a probe that reads the roster the way a real
// editor does. The PROVIDER is deliberately NOT mocked: a stand-in for it
// records the value it was handed and returns its children either way, so it
// cannot tell whether the page actually nested anything inside — and a
// provider wrapping nothing is exactly the severance this file has to catch.
vi.mock('@web/spaces', () => {
  /** Stands in for a space body, reading the roster the way an editor does. */
  function RosterProbe(): React.JSX.Element {
    const names = useCollaboratorNames();
    return (
      <div data-testid='roster-probe'>
        {names ? (names.resolve('u-them') ?? 'unresolved') : 'no-provider'}
      </div>
    );
  }
  return { SPACE_TYPES: { canvas: { bodyComponent: RosterProbe } } };
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
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    usersNow = new Map();
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
        membershipTier: 'base',
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('re-fetches the member list when somebody comes online', async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    usersNow = presence({ 'u-them': true });
    rerender(
      <MemoryRouter initialEntries={[`/project/demo-${PID}`]}>
        <Routes>
          <Route path='/project/:projectId' element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch while nobody is online', async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    // A NEW map with the same contents. Handing back the same one would leave
    // the effect's dependency unchanged, so it would not run and this case
    // would assert nothing beyond the mount — measured: with the refresh made
    // unconditional, every case in this file stayed green.
    usersNow = new Map();
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

  it('puts the roster where the space body can read it', async () => {
    // The one remaining link, and it has to be checked from BELOW. The page
    // could publish a perfect roster into a provider that wraps nothing —
    // types, lint and the rest of the suite all stay green — and every editor
    // in the product would resolve nobody. Only a consumer rendered inside the
    // page can tell the difference.
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('roster-probe')).toHaveTextContent('Them'),
    );
  });

  it('reaches the space body with a resolver even before the roster lands', async () => {
    // From the first render, when the fetch has not returned. What arrives is
    // a working resolver over an empty roster, not nothing — so an editor that
    // mounts early asks and is told "nobody", which is how a caret ends up as
    // a bare colour line rather than a crash or a wait.
    renderPage();
    expect(screen.getByTestId('roster-probe')).toHaveTextContent('unresolved');

    await waitFor(() =>
      expect(screen.getByTestId('roster-probe')).toHaveTextContent('Them'),
    );
  });
});
