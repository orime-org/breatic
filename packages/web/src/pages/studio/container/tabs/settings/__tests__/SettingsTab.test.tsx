// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How the settings tab wires its two write surfaces together.
 *
 * The name and the slug are saved by the same mutation, so "a save is running"
 * is not the same question as "this rename is running". The rename dialog
 * refuses to close while its own request is out, and a flag that cannot tell
 * the two apart turns that refusal into a trap: press Save on the name, then
 * open the rename dialog, and it is a modal with no way out over a rename
 * nobody submitted.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { studiosApi } from '@web/data/api/studios';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@web/domain/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    update: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    leave: vi.fn(),
    liveTransfer: vi.fn().mockResolvedValue(null),
    checkSlugAvailable: vi.fn().mockResolvedValue({ available: true }),
  },
}));

const STUDIO: StudioDetail = {
  id: 's1',
  slug: 'acme-studio',
  name: 'Acme',
  type: 'team',
  avatarUrl: null,
  bio: null,
  memberCount: 3,
  myStudioRole: 'admin',
};

/**
 * Render the whole settings tab.
 * @returns The render result.
 */
function renderTab(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsTab studio={STUDIO} members={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.liveTransfer).mockResolvedValue(null);
  vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
    available: true,
  });
});

describe('SettingsTab — a save of one thing must not seize the other', () => {
  it('leaves the rename dialog dismissible while a NAME save is in flight', async () => {
    // Never resolves: the name's PATCH stays out for the whole case.
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));

    renderTab();
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(studiosApi.update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('settings-slug-open'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('settings-slug-cancel'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('settings-slug-dialog'),
      ).not.toBeInTheDocument(),
    );
  });

  it('still locks the rename dialog while the RENAME itself is in flight', async () => {
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));

    renderTab();
    fireEvent.click(screen.getByTestId('settings-slug-open'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('studio.container.settings.slug'), {
      target: { value: 'acme-renamed' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-slug-confirm'));
    await waitFor(() => expect(studiosApi.update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('settings-slug-cancel'));
    expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument();
    expect(
      screen.getByLabelText('studio.container.settings.slug'),
    ).toHaveValue('acme-renamed');
  });
});
