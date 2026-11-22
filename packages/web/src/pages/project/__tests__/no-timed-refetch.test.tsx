// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Project page asks the server again only when a live update says something changed (#1580, test spec I-03, I-05,
 * I-11): ten minutes with no message read the bell, the live transfer and a waiting upload no further. The bell is
 * the same component on the Studio top bar, which the Studio page's one poll reads again instead. A waveform waiting
 * to be made and a 3D task list with a deadline are held to the same ten minutes by G-09 (`use-audio-peaks.test.ts`)
 * and F-11 (`SceneTaskList.test.tsx`).
 */

import type { ReactElement } from 'react';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProjectsModule from '@web/data/api/projects';
import type * as MembersModule from '@web/data/api/members';
import type * as AssetsModule from '@web/data/api/assets';

vi.mock('@web/data/api/notifications', () => ({
  notificationsApi: { list: vi.fn(), count: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() },
  EMPTY_RESOLVED: { users: {}, studios: {}, projects: {} },
}));
vi.mock('@web/data/api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectsModule>();
  return { ...actual, projectsApi: { ...actual.projectsApi, liveTransfer: vi.fn() } };
});
vi.mock('@web/data/api/members', async (importOriginal) => {
  const actual = await importOriginal<typeof MembersModule>();
  return { ...actual, membersApi: { ...actual.membersApi, transferCandidates: vi.fn() } };
});
vi.mock('@web/data/api/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsModule>();
  return { ...actual, assetsApi: { ...actual.assetsApi, fetchUploadConfig: vi.fn() } };
});

import { BellMenu } from '@web/features/notifications/BellMenu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { MembersModal } from '@web/pages/project/chrome/top-bar/MembersModal';
import { notificationsApi, EMPTY_RESOLVED } from '@web/data/api/notifications';
import { projectsApi } from '@web/data/api/projects';
import { membersApi, type Member } from '@web/data/api/members';
import { assetsApi } from '@web/data/api/assets';
import { waitForUploadEnding } from '@web/data/upload/upload-status';
import { useCurrentUserStore } from '@web/stores';
import { useUIStore } from '@web/stores/ui';

const TEN_MINUTES = 10 * 60_000;

const SELF = { id: 'u-a', name: 'Self', email: 'a@e.com', personalStudio: null, membershipTier: 'base' as const };
const MEMBERS: ReadonlyArray<Member> = [
  { id: 'u-a', userId: 'u-a', name: 'Owner', email: 'a@e.com', role: 'owner' },
  { id: 'u-b', userId: 'u-b', name: 'Editor', email: 'b@e.com', role: 'editor' },
];

/**
 * Render under a fresh query client and the providers the bell needs.
 * @param ui - What to render.
 * @returns The render result.
 */
function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * Let the first reads settle, then let ten minutes pass with no message.
 * @returns Once both have run.
 */
async function firstReadThenTenMinutes(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: SELF });
  useUIStore.setState({ activeOverlayId: null });
  // The members dialog is open, as it is while its transfer section shows.
  useUIStore.getState().setActiveOverlayId('members-modal');
  vi.mocked(notificationsApi.list).mockResolvedValue({ items: [], resolved: EMPTY_RESOLVED });
  vi.mocked(projectsApi.liveTransfer).mockResolvedValue(null);
  vi.mocked(membersApi.transferCandidates).mockResolvedValue([]);
  vi.mocked(assetsApi.fetchUploadConfig).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('with no live update for ten minutes', () => {
  it('I-03 the bell is read once', async () => {
    const view = mount(<BellMenu />);
    await firstReadThenTenMinutes();
    expect(notificationsApi.list).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('I-05 the members dialog reads the live transfer once', async () => {
    const view = mount(<MembersModal projectId='p1' members={MEMBERS} currentUserId='u-a' currentUserRole='owner' />);
    await firstReadThenTenMinutes();
    expect(projectsApi.liveTransfer).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('I-11 the bell, the live transfer and a waiting upload are not read again', async () => {
    const stop = new AbortController();
    const waiting = waitForUploadEnding('uploads/waiting.png', stop.signal).catch(() => undefined);
    const view = mount(
      <>
        <BellMenu />
        <MembersModal projectId='p1' members={MEMBERS} currentUserId='u-a' currentUserRole='owner' />
      </>,
    );
    await firstReadThenTenMinutes();
    expect(notificationsApi.list).toHaveBeenCalledTimes(1);
    expect(projectsApi.liveTransfer).toHaveBeenCalledTimes(1);
    expect(assetsApi.fetchUploadConfig).not.toHaveBeenCalled();
    view.unmount();
    stop.abort();
    await waiting;
  });
});
