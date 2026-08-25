// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whose new Space is this? — the claim, on the client side (design §10.3).
 *
 * The server mints Space ids now, so the machine that asked never knew the id
 * in advance and cannot watch for it. What it can watch for is the claim token
 * it generated for that one click, which travels out with `space:create` and
 * comes back on the entry in the broadcast (§5.2). Everyone on the project
 * receives that broadcast; only the machine that made the token recognises it.
 *
 * `createdBy` cannot stand in for the token: one account signed in on three
 * machines matches on all three, and all three would open the tab. A probe
 * written on 2026-07-31 asserted exactly that and failed —
 *
 *     AssertionError: expected 'sp-other-machine' to be null
 *
 * — it opened the Space another machine had created. The first case here is
 * that probe, made permanent: a foreign token lands, and this page must leave
 * it alone. The second is the other half of the same claim — the entry
 * carrying THIS machine's token has to be opened and activated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
  act,
  fireEvent,
  type RenderOptions,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import type { SpaceRpcRequest, SpaceRpcResponse } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useCurrentUserStore, useUIStore } from '@web/stores';

/**
 * A request as `sendSpaceRpc` receives it — the correlation id is added
 * inside the client. Written distributively so the tagged union survives:
 * a plain `Omit` over a union collapses the members into one object type
 * and `req.type === 'space:create'` stops narrowing the payload.
 */
type RpcRequest =
  SpaceRpcRequest extends infer T
    ? T extends SpaceRpcRequest
      ? Omit<T, 'id'>
      : never
    : never;

const PID = '11111111-1111-4111-8111-111111111111';
const SPACE_A = '22222222-2222-4222-8222-222222222222';
const SPACE_B = '33333333-3333-4333-8333-333333333333';
/** The Space another machine on this same account created. */
const SPACE_ELSEWHERE = '44444444-4444-4444-8444-444444444444';
/** The Space this machine asked for. */
const SPACE_MINE = '55555555-5555-4555-8555-555555555555';
/** The claim token the other machine generated — never seen by this page. */
const TOKEN_ELSEWHERE = '66666666-6666-4666-8666-666666666666';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

/**
 * Stands in for a mounted provider. `callRpc` only checks it is non-null, but
 * the activity panel subscribes to `stateless` on it, so it needs the two
 * listener methods to mount at all.
 */
const fakeProvider = { on: (): void => {}, off: (): void => {} } as never;

/**
 * The live meta state, mutable so a case can land a broadcast: a new entry in
 * the shared spaces list, or an id joining this account's open-tab list. Both
 * are server-owned and arrive the same way — over the wire, not from a local
 * write. Re-rendering is triggered separately (see `landBroadcast`).
 */
const meta: {
  spaces: Array<{
    id: string;
    name: string;
    type: 'document';
    claimToken?: string;
  }>;
  openTabIds: string[];
} = {
  spaces: [
    { id: SPACE_A, name: 'Space A', type: 'document' },
    { id: SPACE_B, name: 'Space B', type: 'document' },
  ],
  openTabIds: [SPACE_A, SPACE_B],
};

vi.mock('@web/data/yjs/project-meta', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/project-meta')
      >('@web/data/yjs/project-meta');
  return {
    ...actual,
    useProjectMeta: (): ReturnType<
      typeof import('@web/data/yjs/project-meta').useProjectMeta
    > => ({
      spaces: meta.spaces,
      openTabIds: meta.openTabIds,
      users: new Map(),
      synced: true,
      provider: fakeProvider,
      status: 'connected',
      authFailedReason: null,
    }),
  };
});

const sendSpaceRpcMock = vi.fn();
vi.mock('@web/data/yjs/space-rpc-client', async () => {
  const actual = await vi.importActual<
    typeof import('@web/data/yjs/space-rpc-client')
      >('@web/data/yjs/space-rpc-client');
  return {
    ...actual,
    sendSpaceRpc: (...a: unknown[]) => sendSpaceRpcMock(...a),
  };
});

vi.mock('@web/pages/project/use-record-project-open', () => ({
  useRecordProjectOpen: (): undefined => undefined,
}));

vi.mock('@web/pages/project/LeaveProjectGuard', () => ({
  LeaveProjectGuard: (): null => null,
}));

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
 * Wraps the page in the providers it needs.
 * @param root0 - Component props.
 * @param root0.children - Subtree to wrap.
 * @returns The wrapped subtree.
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
 * Render the project page with two open tabs and a mounted provider.
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
 * Walk the create dialog: pick Document, name it, submit.
 * @param name - The name to type into the dialog.
 */
async function createSpace(name: string): Promise<void> {
  (await screen.findByTestId('new-space-button')).click();
  (await screen.findByRole('radio', { name: /Document/ })).click();
  fireEvent.change(await screen.findByLabelText('Name'), {
    target: { value: name },
  });
  (await screen.findByRole('button', { name: 'Create' })).click();
}

/**
 * Apply a server-owned change to the meta state and make the page read it
 * again. The mocked `useProjectMeta` has no subscription of its own, so the
 * re-render is driven through a UI-store field the page already watches —
 * standing in for the Yjs update that would arrive with the broadcast.
 * @param mutate - Mutation to apply to `meta` before the re-render.
 */
function landBroadcast(mutate: () => void): void {
  act(() => {
    mutate();
    useUIStore.setState((s) => ({
      chatPanelCollapsed: !s.chatPanelCollapsed,
    }));
  });
}

/**
 * The RPC types this page has sent so far, in order.
 * @returns One entry per `sendSpaceRpc` call.
 */
function sentTypes(): string[] {
  return sendSpaceRpcMock.mock.calls.map(
    (c) => (c[1] as RpcRequest).type,
  );
}

/**
 * The `aria-selected` state of a Space tab, as the tab strip renders it.
 * @param id - The Space id whose tab to read.
 * @returns The literal attribute value.
 */
function tabSelected(id: string): string | null {
  return screen.getByTestId(`space-tab-${id}`).getAttribute('aria-selected');
}

describe('ProjectPage — only the machine that asked claims the new Space', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meta.spaces = [
      { id: SPACE_A, name: 'Space A', type: 'document' },
      { id: SPACE_B, name: 'Space B', type: 'document' },
    ];
    meta.openTabIds = [SPACE_A, SPACE_B];
    useUIStore.setState({ chatPanelCollapsed: true, spaceOpInProgress: null });
    useCurrentUserStore.setState({
      user: {
        id: 'u-me',
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
        membershipTier: 'base',
      },
    });
  });

  it('a Space the same account created on ANOTHER machine is not opened here', async () => {
    let myToken: string | undefined;
    sendSpaceRpcMock.mockImplementation(
      async (
        _provider: unknown,
        req: RpcRequest,
      ): Promise<SpaceRpcResponse> => {
        if (req.type === 'space:create') {
          myToken = req.payload.claimToken;
        }
        return { id: 'r1', ok: true };
      },
    );
    setup();

    // This machine asks for a Space of its own, so the claim effect is armed
    // and watching — the state in which a foreign entry is dangerous.
    await createSpace('Mine');
    await waitFor(() => expect(myToken).toBeDefined());

    // The other machine's create lands first: its entry appears in the shared
    // spaces list, and — because the open-tab list belongs to the ACCOUNT, not
    // to a machine — its `tab:open` puts the id in this page's tab bar too
    // (§5.4 steps 4-5). Everything about it is visible here except the token.
    landBroadcast(() => {
      meta.spaces = [
        ...meta.spaces,
        {
          id: SPACE_ELSEWHERE,
          name: 'Made elsewhere',
          type: 'document',
          claimToken: TOKEN_ELSEWHERE,
        },
      ];
      meta.openTabIds = [...meta.openTabIds, SPACE_ELSEWHERE];
    });

    // It really arrived — the claim effect re-ran with this entry in view.
    await screen.findByTestId(`space-tab-${SPACE_ELSEWHERE}`);
    expect(
      screen.getByTestId(`space-tab-name-${SPACE_ELSEWHERE}`).textContent,
    ).toBe('Made elsewhere');

    // The tab is in the strip, and the view has NOT moved to it. This is the
    // row §10.5 spells out for the two machines that did not ask.
    expect(tabSelected(SPACE_ELSEWHERE)).toBe('false');
    expect(tabSelected(SPACE_A)).toBe('true');

    // No `tab:open` was sent for it: this page did not act on someone else's
    // Space at all. `space:create` (its own, still unanswered) is the only
    // request it has made.
    expect(sentTypes()).toEqual(['space:create']);

    // And its own create is still outstanding, so the overlay stays up —
    // a foreign entry must not be mistaken for an answer.
    expect(screen.getByTestId('creating-space-overlay')).toBeTruthy();
  });

  it('the Space THIS machine created is opened and activated here', async () => {
    let myToken: string | undefined;
    sendSpaceRpcMock.mockImplementation(
      async (
        _provider: unknown,
        req: RpcRequest,
      ): Promise<SpaceRpcResponse> => {
        if (req.type === 'space:create') {
          myToken = req.payload.claimToken;
          // Both broadcasts land together: the other machine's Space, then
          // ours. Ours is second on purpose — anything that reaches for "the
          // newest entry" or "the first one with a token" picks the wrong one.
          meta.spaces = [
            ...meta.spaces,
            {
              id: SPACE_ELSEWHERE,
              name: 'Made elsewhere',
              type: 'document',
              claimToken: TOKEN_ELSEWHERE,
            },
            {
              id: SPACE_MINE,
              name: 'Mine',
              type: 'document',
              claimToken: myToken,
            },
          ];
          // The other machine already opened its own tab, and the tab list
          // belongs to the account — so its id is in this page's strip too.
          meta.openTabIds = [...meta.openTabIds, SPACE_ELSEWHERE];
        }
        if (req.type === 'tab:open') {
          // The server writes the tab list and broadcasts it back.
          meta.openTabIds = [...meta.openTabIds, req.payload.spaceId];
        }
        return { id: 'r1', ok: true };
      },
    );
    setup();

    await createSpace('Mine');
    await waitFor(() => expect(myToken).toBeDefined());

    // The create's broadcast reaches this page.
    landBroadcast(() => {});

    // It recognised its own token and asked for that tab — exactly one
    // `tab:open`, naming the Space it asked for and not the other one.
    await waitFor(() => {
      expect(sentTypes()).toEqual(['space:create', 'tab:open']);
    });
    const openReq = sendSpaceRpcMock.mock.calls[1]?.[1] as RpcRequest;
    expect(openReq.payload).toEqual({ spaceId: SPACE_MINE });

    // The tab list comes back from the server carrying the new id.
    landBroadcast(() => {});

    expect(tabSelected(SPACE_MINE)).toBe('true');
    expect(tabSelected(SPACE_A)).toBe('false');
    expect(tabSelected(SPACE_ELSEWHERE)).toBe('false');

    // The create is answered, so the overlay goes away.
    expect(screen.queryByTestId('creating-space-overlay')).toBeNull();
  });
});
