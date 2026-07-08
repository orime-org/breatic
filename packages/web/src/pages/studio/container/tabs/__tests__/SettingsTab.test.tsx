// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { studiosApi } from '@web/data/api/studios';
import type {
  StudioDetail,
  StudioMember,
} from '@web/pages/studio/container/container-types';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { requestTransfer: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select drives its trigger with pointer-capture + scrollIntoView, which
// jsdom does not implement — polyfill them so the listbox can open in tests.
beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => vi.clearAllMocks());

const TEAM: StudioDetail = {
  id: 's1',
  slug: 'acme',
  name: 'Acme',
  type: 'team',
  memberCount: 3,
  myStudioRole: 'admin',
};

/**
 * Builds a studio member fixture.
 * @param id - The member's user id.
 * @param name - The member's display name.
 * @param studioRole - The member's studio role.
 * @returns the member fixture.
 */
function member(
  id: string,
  name: string,
  studioRole: StudioMember['studioRole'],
): StudioMember {
  return {
    id,
    name,
    email: `${id}@example.com`,
    avatarUrl: null,
    studioRole,
    joinedAt: '2026-04-01T00:00:00.000Z',
  };
}

const ADMIN = member('u-admin', 'Ada Admin', 'admin');
const MAINTAINER = member('u-maint', 'Max Maintainer', 'maintainer');
const GUEST = member('u-guest', 'Gil Guest', 'guest');

/**
 * Renders the given UI inside a fresh React Query client (SettingsTab's transfer
 * mutation needs a provider).
 * @param ui - The element to render.
 * @returns the render result.
 */
function renderTab(ui: ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('SettingsTab — transfer studio (single entry, 2026-07-08)', () => {
  it('sends a transfer request to the picked maintainer', async () => {
    const user = userEvent.setup();
    vi.mocked(studiosApi.requestTransfer).mockResolvedValueOnce({ ok: true });
    renderTab(
      <SettingsTab studio={TEAM} members={[ADMIN, MAINTAINER, GUEST]} />,
    );

    await user.click(screen.getByTestId('settings-transfer-open'));
    await user.click(await screen.findByTestId('settings-transfer-select'));
    await user.click(await screen.findByText(/Max Maintainer/));
    await user.click(screen.getByTestId('settings-transfer-send'));

    await waitFor(() => {
      expect(studiosApi.requestTransfer).toHaveBeenCalledWith('acme', {
        toUserId: MAINTAINER.id,
      });
    });
  });

  it('offers only maintainers as candidates (excludes the admin + guests)', async () => {
    const user = userEvent.setup();
    renderTab(
      <SettingsTab studio={TEAM} members={[ADMIN, MAINTAINER, GUEST]} />,
    );
    await user.click(screen.getByTestId('settings-transfer-open'));
    await user.click(await screen.findByTestId('settings-transfer-select'));

    expect(await screen.findByText(/Max Maintainer/)).toBeInTheDocument();
    expect(screen.queryByText(/Ada Admin/)).toBeNull();
    expect(screen.queryByText(/Gil Guest/)).toBeNull();
  });

  it('shows a no-candidates message when there is no maintainer', async () => {
    const user = userEvent.setup();
    renderTab(<SettingsTab studio={TEAM} members={[ADMIN, GUEST]} />);
    await user.click(screen.getByTestId('settings-transfer-open'));

    expect(
      await screen.findByText(/No Maintainers to transfer to/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('settings-transfer-send')).toBeInTheDocument();
  });
});
